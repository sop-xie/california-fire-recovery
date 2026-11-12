"""Write the map data behind the interactive site into data/ (the folder the website loads). Run after analyze.py.

Writes:
    data/map/<burn year>.json   every 1 km cell that burned that year, with a one-letter
                                     status per August from the year after the fire to the
                                     latest year
    data/map/meta.json          grid layout and the burn years available
    data/california.json        California's outline as [lon, lat] rings

Land is first checked the August after its fire year, so every fire has had a full growing
season before its first check (see writeup.html).

Status letters, per August:
    s  still scarred: more than 0.05 NDVI below normal
    r  recovered: within 0.05 of normal, or greener
    b  burned again in a later fire, so it now counts under that later year
    x  no greenness comparison available that year

It also rewrites site/data/scarred_area.csv, the stacked bar data, from the same cells,
so the acres on the map always add up to the acres in the bars. Cells are grouped the way
analyze.py groups them; the bar totals can differ from analyze.py's by a cell or two,
because the saved change values are rounded to float16 and a few cells sit right at -0.05.
"""
import json

import numpy as np
import pandas as pd

from analyze import BURNED, SCARRED, burned_share
from common import (ACRES_PER_KM2, DATA, NORTH, PROJ, RES, WEST, california_mask,
                    california_rings, cell_area_km2)

SITE_DATA = PROJ / 'data'  # what the website loads


def main():
    pixels = pd.read_csv(DATA / 'ca_burned_pixels.csv.gz', parse_dates=['date'])
    pixels['year'], pixels['month'] = pixels.date.dt.year, pixels.date.dt.month
    change_file = np.load(DATA / 'ca_ndvi_change_001.npz')
    years = [int(y) for y in change_file['years']]
    change = change_file['change'].astype(np.float32)
    mask = california_mask()
    area = cell_area_km2()
    shape = mask.shape

    burn_years = sorted(pixels.year.unique())
    hit = {year: (burned_share(group, shape, area) >= BURNED) & mask
           for year, group in pixels.groupby('year')}

    # The most recent burn year of each cell as of each August, as in analyze.py: land is
    # first checked the August after its fire year.
    latest = {}
    for year in years:
        grid = np.zeros(shape, np.int16)
        for burn_year in burn_years:
            if burn_year >= year:
                break
            grid[hit[burn_year]] = burn_year
        latest[year] = grid

    out = SITE_DATA / 'map'
    out.mkdir(parents=True, exist_ok=True)
    exported = []
    bar_rows = []
    for burn_year in burn_years:
        if burn_year < 2001 or burn_year >= years[-1]:
            continue
        rows, cols = np.nonzero(hit[burn_year])
        shown = [y for y in years if y > burn_year]
        codes = np.full((len(rows), len(shown)), 'x')
        for j, year in enumerate(shown):
            i = years.index(year)
            now = latest[year][rows, cols]
            values = change[i][rows, cols]
            mine = now == burn_year
            codes[mine & np.isnan(values), j] = 'x'
            codes[mine & (values < SCARRED), j] = 's'
            codes[mine & (values >= SCARRED), j] = 'r'
            codes[now > burn_year, j] = 'b'

            acres = area[rows, cols] * ACRES_PER_KM2
            burned = round(float(acres[np.isin(codes[:, j], ['s', 'r'])].sum()))
            reburned = round(float(acres[codes[:, j] == 'b'].sum()))
            no_data = round(float(acres[codes[:, j] == 'x'].sum()))
            if burned or reburned:
                scarred = round(float(acres[codes[:, j] == 's'].sum()))
                bar_rows.append((year, int(burn_year), scarred, burned, reburned, no_data))

        payload = {
            'burnYear': int(burn_year),
            'years': shown,
            'cells': [[int(r), int(c), ''.join(code)] for r, c, code in zip(rows, cols, codes)],
        }
        (out / f'{burn_year}.json').write_text(json.dumps(payload, separators=(',', ':')))
        exported.append(int(burn_year))
        print(f'{burn_year}: {len(rows):,} cells')

    # burned_acres: land still counted under this burn year (scarred + recovered).
    # reburned_acres: land that has burned again since, so it now counts under a later year.
    # no_data_acres: land with no greenness comparison that August.
    bars = pd.DataFrame(bar_rows, columns=['august', 'burn_year', 'scarred_acres', 'burned_acres',
                                           'reburned_acres', 'no_data_acres'])
    bars.sort_values(['august', 'burn_year']).to_csv(SITE_DATA / 'scarred_area.csv', index=False)
    original = pd.read_csv(DATA / 'ca_scarred_area_by_fire_year.csv')
    compare = bars.merge(original, on=['august', 'burn_year'], suffixes=('', '_analyze'))
    drift = (compare.scarred_acres - compare.scarred_acres_analyze).abs().max()
    print(f'Bar rows: {len(bars)}; largest scarred-acre difference from analyze.py: {drift:,.0f}')

    meta = {'west': WEST, 'north': NORTH, 'res': RES, 'rows': shape[0], 'cols': shape[1],
            'burnYears': exported, 'scarredBelow': SCARRED}
    (out / 'meta.json').write_text(json.dumps(meta))
    rings = [np.round(ring, 3).tolist() for ring in california_rings()]
    (SITE_DATA / 'california.json').write_text(json.dumps(rings, separators=(',', ':')))
    print('done')


if __name__ == '__main__':
    main()
