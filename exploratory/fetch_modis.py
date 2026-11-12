"""Download monthly NASA MODIS data from the GIBS API as CSV files for D3.

GIBS only serves pictures, not numbers. Each layer publishes a colormap that
says which color stands for which value, so this script requests a map as a
PNG and converts every pixel back to its value. No API key is needed.

Setup:
    pip install requests pillow numpy pandas

Usage:
    python fetch_modis.py --region cedar --layers ndvi
    python fetch_modis.py --region sierra --layers snow lst_day --start 2001-01
    python fetch_modis.py --name mybox --bbox -118 33 -116 35 --layers ndvi

Writes two files into data/:
    <region>_grid.csv    date, lat, lon, one column per layer (for maps)
    <region>_series.csv  date, one column per layer, averaged over the region
"""
import argparse
import io
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from PIL import Image

WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
CAPABILITIES_URL = ('https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/'
                    '1.0.0/WMTSCapabilities.xml')
COLORMAP_URL = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/{}.xml'

WMTS = '{http://www.opengis.net/wmts/1.0}'
OWS = '{http://www.opengis.net/ows/1.1}'

# offset turns the value into friendlier units (Kelvin to Celsius).
# transparent_value is what a see-through pixel means. The snow colormap draws
# 0% snow as transparent, so for snow it counts as 0. Everywhere else
# transparent means no data, and those pixels become NaN.
LAYERS = {
    'ndvi': dict(id='MODIS_Terra_L3_NDVI_Monthly', colormap='MODIS_L3_NDVI'),
    'evi': dict(id='MODIS_Terra_L3_EVI_Monthly', colormap='MODIS_L3_EVI'),
    'lst_day': dict(id='MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day',
                    colormap='MODIS_Land_Surface_Temp', offset=-273.15),
    'lst_night': dict(id='MODIS_Terra_L3_Land_Surface_Temp_Monthly_Night',
                      colormap='MODIS_Land_Surface_Temp', offset=-273.15),
    'snow': dict(id='MODIS_Terra_L3_Snow_Cover_Monthly_Average_Pct',
                 colormap='MODIS_NDSI_Snow_Cover', transparent_value=0.0),
}

# west, south, east, north in degrees
REGIONS = {
    'cedar': (-117.2, 32.7, -116.4, 33.3),   # San Diego County, 2003 Cedar Fire
    'sierra': (-121.5, 36.5, -117.5, 40.5),  # Sierra Nevada
    'socal': (-119.0, 32.5, -116.0, 34.8),   # Los Angeles to San Diego
}

FINEST_DEGREES = 0.01  # about 1 km, the finest detail the monthly layers carry
MAX_IMAGE_SIDE = 2000


def available_dates(layer_id, capabilities):
    """Return the dates a layer really has.

    WMS snaps a missing date to the nearest real one without warning, so asking
    for a month that does not exist would silently return a different month.
    """
    root = ET.fromstring(capabilities)
    for layer in root.iter(WMTS + 'Layer'):
        if layer.find(OWS + 'Identifier').text != layer_id:
            continue
        dates = []
        for value in layer.find(WMTS + 'Dimension').findall(WMTS + 'Value'):
            start, end, _period = value.text.split('/')
            dates += pd.date_range(start, end, freq='MS').strftime('%Y-%m-%d').tolist()
        return dates
    raise ValueError(f'{layer_id} is not in the GIBS layer list')


def load_colormap(name):
    """Return a dict mapping (r, g, b) to the middle of that color's value bin."""
    response = requests.get(COLORMAP_URL.format(name), timeout=60)
    response.raise_for_status()
    lookup = {}
    for entry in ET.fromstring(response.content).iter('ColorMapEntry'):
        # Entries without a value are labels such as "cloud" or "ocean".
        if entry.get('value') is None or entry.get('nodata') == 'true':
            continue
        numbers = [float(n) for n in re.findall(r'-?\d+\.?\d*', entry.get('value'))]
        rgb = tuple(int(c) for c in entry.get('rgb').split(','))
        lookup[rgb] = sum(numbers) / len(numbers)
    return lookup


def fetch_image(layer_id, date, bbox, width, height):
    """Request one map from GIBS and return it as an RGBA array."""
    west, south, east, north = bbox
    params = {
        'service': 'WMS', 'version': '1.3.0', 'request': 'GetMap',
        'format': 'image/png', 'layers': layer_id, 'styles': '',
        'crs': 'EPSG:4326', 'bbox': f'{south},{west},{north},{east}',
        'width': width, 'height': height, 'time': date,
    }
    for attempt in range(4):
        try:
            response = requests.get(WMS_URL, params=params, timeout=90)
            # GIBS reports some errors as XML with a 200 status.
            if response.ok and response.headers['content-type'] == 'image/png':
                return np.array(Image.open(io.BytesIO(response.content)).convert('RGBA'))
        except requests.RequestException:
            pass
        time.sleep(2 ** attempt)
    raise RuntimeError(f'GIBS failed for {layer_id} on {date}')


def pixels_to_values(rgba, lookup, transparent_value=np.nan, offset=0.0):
    """Convert an RGBA array into a 2D array of data values."""
    colors, inverse = np.unique(rgba[..., :3].reshape(-1, 3), axis=0, return_inverse=True)
    by_color = np.array([lookup.get(tuple(int(c) for c in color), np.nan) for color in colors])
    values = by_color[inverse.ravel()].reshape(rgba.shape[:2]) + offset
    values[rgba[..., 3] == 0] = transparent_value
    return values


def coarsen(values, factor):
    """Average blocks of factor x factor pixels, ignoring NaNs."""
    if factor == 1:
        return values
    rows, cols = values.shape[0] // factor, values.shape[1] // factor
    blocks = values[:rows * factor, :cols * factor].reshape(rows, factor, cols, factor)
    counts = (~np.isnan(blocks)).sum(axis=(1, 3))
    totals = np.nansum(blocks, axis=(1, 3))
    return np.divide(totals, counts, out=np.full((rows, cols), np.nan), where=counts > 0)


def fetch_layer(key, dates, bbox, res):
    """Download one layer and return {date: 2D value array}."""
    layer = LAYERS[key]
    lookup = load_colormap(layer['colormap'])
    west, south, east, north = bbox
    cols, rows = round((east - west) / res), round((north - south) / res)
    factor = max(1, min(round(res / FINEST_DEGREES), MAX_IMAGE_SIDE // max(cols, rows)))

    def fetch_month(date):
        rgba = fetch_image(layer['id'], date, bbox, cols * factor, rows * factor)
        values = pixels_to_values(rgba, lookup, layer.get('transparent_value', np.nan),
                                  layer.get('offset', 0.0))
        return date, coarsen(values, factor)

    results = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for date, grid in pool.map(fetch_month, dates):
            results[date] = grid
            print(f'  {key} {date}: mean {np.nanmean(grid):.3f}' if np.isfinite(grid).any()
                  else f'  {key} {date}: no data', flush=True)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--region', choices=REGIONS)
    parser.add_argument('--name', help='file name prefix when using --bbox')
    parser.add_argument('--bbox', nargs=4, type=float,
                        metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'))
    parser.add_argument('--layers', nargs='+', choices=LAYERS, default=['ndvi'])
    parser.add_argument('--start', default='2000-01', help='first month, YYYY-MM')
    parser.add_argument('--end', default='2100-01', help='last month, YYYY-MM')
    parser.add_argument('--res', type=float, default=0.05,
                        help='grid cell size in degrees (0.05 is about 5 km)')
    parser.add_argument('--out', default=str(Path(__file__).parent / 'data'))
    args = parser.parse_args()

    if not args.region and not (args.bbox and args.name):
        parser.error('give --region, or both --bbox and --name')
    bbox = REGIONS[args.region] if args.region else tuple(args.bbox)
    name = args.region or args.name

    print('Reading the GIBS layer list...')
    capabilities = requests.get(CAPABILITIES_URL, timeout=120).content

    grids = {}
    for key in args.layers:
        dates = [d for d in available_dates(LAYERS[key]['id'], capabilities)
                 if f'{args.start}-01' <= d <= f'{args.end}-01']
        print(f'{key}: {len(dates)} months')
        grids[key] = fetch_layer(key, dates, bbox, args.res)

    west, _south, _east, north = bbox
    tables = []
    for key, by_date in grids.items():
        for date, grid in by_date.items():
            rows, cols = np.indices(grid.shape)
            tables.append(pd.DataFrame({
                'date': date,
                'lat': np.round(north - (rows.ravel() + 0.5) * args.res, 3),
                'lon': np.round(west + (cols.ravel() + 0.5) * args.res, 3),
                'layer': key,
                'value': np.round(grid.ravel(), 3),
            }))
    long = pd.concat(tables)
    grid = (long.pivot_table(index=['date', 'lat', 'lon'], columns='layer', values='value')
            .reset_index().rename_axis(columns=None))
    series = (long.groupby(['date', 'layer'])['value'].mean().unstack('layer')
              .round(3).reset_index().rename_axis(columns=None))

    out = Path(args.out)
    out.mkdir(exist_ok=True)
    grid.to_csv(out / f'{name}_grid.csv', index=False)
    series.to_csv(out / f'{name}_series.csv', index=False)
    print(f'Wrote {out / f"{name}_grid.csv"} ({len(grid):,} rows)')
    print(f'Wrote {out / f"{name}_series.csv"} ({len(series):,} rows)')


if __name__ == '__main__':
    main()
