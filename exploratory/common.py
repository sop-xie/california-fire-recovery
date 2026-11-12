"""Shared paths, the California grid, and the state outline for the exploratory scripts."""
import json
import sys
from pathlib import Path

import numpy as np
from matplotlib.path import Path as Polygon

PROJ = Path(__file__).resolve().parent.parent
DATA = PROJ / 'raw-data'  # big downloads, not in git
FIGURES = Path(__file__).resolve().parent / 'figures'
sys.path.insert(0, str(PROJ))

# One grid for everything: 0.01 degrees (about 1 km), covering all of California.
WEST, SOUTH, EAST, NORTH = -124.5, 32.5, -114.0, 42.1
RES = 0.01
COLS = round((EAST - WEST) / RES)
ROWS = round((NORTH - SOUTH) / RES)

# A MODIS burned-area pixel is 463.3 m on a side, an equal-area grid.
MODIS_PIXEL_KM2 = 0.4633127165 ** 2
ACRES_PER_KM2 = 247.105


def cell_centers(res=RES):
    """Return 2D arrays of cell-center latitude and longitude, north at the top."""
    cols, rows = round((EAST - WEST) / res), round((NORTH - SOUTH) / res)
    lon = WEST + (np.arange(cols) + 0.5) * res
    lat = NORTH - (np.arange(rows) + 0.5) * res
    return np.meshgrid(lat, lon, indexing='ij')


def cell_area_km2(res=RES):
    """Area of each grid cell, which shrinks toward the pole."""
    lat, _lon = cell_centers(res)
    side = 111.195 * res
    return side * side * np.cos(np.radians(lat))


def california_rings():
    """Return California's outline as a list of (lon, lat) rings from us-atlas."""
    topo = json.loads((DATA / 'geo' / 'states-10m.json').read_text())
    scale, translate = topo['transform']['scale'], topo['transform']['translate']
    arcs = []
    for arc in topo['arcs']:
        points = np.cumsum(np.array(arc, dtype=float), axis=0)
        arcs.append(points * scale + translate)
    state = next(g for g in topo['objects']['states']['geometries']
                 if g['properties']['name'] == 'California')
    rings = []
    for polygon in state['arcs']:
        for ring in polygon:
            points = []
            for index in ring:
                arc = arcs[index] if index >= 0 else arcs[~index][::-1]
                points.extend(arc if not points else arc[1:])
            rings.append(np.array(points))
    return rings


def california_mask(res=RES):
    """True for grid cells whose center falls inside California."""
    lat, lon = cell_centers(res)
    points = np.column_stack([lon.ravel(), lat.ravel()])
    inside = np.zeros(len(points), bool)
    for ring in california_rings():
        inside |= Polygon(ring).contains_points(points)
    return inside.reshape(lat.shape)
