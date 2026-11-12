# Data scripts

These Python scripts download the NASA data and build the files in `../data/` that the website loads.
Run them from this folder, in this order:

1. `python get_burned_area.py`: MODIS burned area (MCD64A1) for California, from the ORNL DAAC web service
2. `python get_ndvi.py`: monthly MODIS NDVI from NASA GIBS (map images converted back to numbers by `fetch_modis.py`)
3. `python analyze.py`: compares each burned 1 km cell's August greenness with its pre-fire normal
4. `python export_site_data.py`: writes `../data/scarred_area.csv`, `../data/map/` and `../data/california.json`
5. `python make_figures.py` (optional): the exploratory charts in `figures/`

Downloads are saved in `../raw-data/` (about 170 MB, not in git). Needs numpy, pandas, scipy, matplotlib and requests.
