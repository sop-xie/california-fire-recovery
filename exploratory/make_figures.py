"""Draw the exploratory figures into exploratory/figures/. Run analyze.py first."""
import math

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import BoundaryNorm, LinearSegmentedColormap, ListedColormap

from common import DATA, EAST, FIGURES, NORTH, SOUTH, WEST, california_rings

SURFACE = '#fcfcfb'
INK = '#0b0b0b'
INK_2 = '#52514e'
MUTED = '#898781'
GRID = '#e1e0d9'
AXIS = '#c3c2b7'
NEUTRAL = '#f0efec'
BLUE = '#2a78d6'
BLUE_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#2a78d6', '#256abf', '#1c5cab',
             '#184f95', '#104281', '#0d366b']
# Ordered classes (burn-year groups) start at step 250 so the lightest still shows on land.
ERAS = [(2001, 2005), (2006, 2010), (2011, 2015), (2016, 2020), (2021, 2026)]
# Red for burned land, light (older) to dark (recent). Lightest step is 2.6:1 on the
# surface, and neighboring steps sit 9.7-11 apart in OKLab (x100).
ERA_COLORS = ['#ec7f7b', '#e34948', '#bd2c2d', '#931c1d', '#661112']
LAND = '#e8e7e2'

plt.rcParams.update({
    'font.family': ['Helvetica Neue', 'Helvetica', 'Arial', 'DejaVu Sans'],
    'font.size': 11, 'text.color': INK, 'axes.labelcolor': INK_2,
    'axes.edgecolor': AXIS, 'axes.linewidth': 0.8, 'xtick.color': MUTED, 'ytick.color': MUTED,
    'xtick.labelcolor': INK_2, 'ytick.labelcolor': INK_2, 'axes.spines.top': False,
    'axes.spines.right': False, 'figure.facecolor': SURFACE, 'axes.facecolor': SURFACE,
    'savefig.facecolor': SURFACE, 'axes.grid': True, 'grid.color': GRID, 'grid.linewidth': 0.6,
    'axes.axisbelow': True, 'legend.frameon': False,
})


def titled(fig, title, subtitle):
    fig.text(0.02, 0.975, title, fontsize=15, fontweight='bold', va='top')
    fig.text(0.02, 0.925, subtitle, fontsize=10.5, color=INK_2, va='top')


def source(fig, text='Source: NASA MODIS Terra monthly NDVI via GIBS'):
    fig.text(0.02, 0.015, text, fontsize=8.5, color=MUTED)


def save(fig, name):
    fig.savefig(FIGURES / name, dpi=200)
    plt.close(fig)
    print('wrote', FIGURES / name)


def draw_outline(ax):
    for ring in california_rings():
        ax.plot(ring[:, 0], ring[:, 1], color=INK_2, lw=0.6)


def map_axes(fig, rect):
    ax = fig.add_axes(rect)
    ax.set_xlim(WEST, EAST)
    ax.set_ylim(SOUTH, NORTH)
    ax.set_aspect(1 / math.cos(math.radians(37.3)))
    ax.axis('off')
    return ax


def fig1_statewide():
    s = pd.read_csv(DATA / 'ca_ndvi_statewide_monthly.csv', parse_dates=['date'])
    aug = s[s.date.dt.month == 8]
    fig = plt.figure(figsize=(11, 5.2))
    titled(fig, "California's greenness swings with wet and dry years, which can hide fire damage",
           'Statewide average NDVI (0 = bare ground, 1 = dense vegetation), every month since 2000')
    ax = fig.add_axes([0.07, 0.13, 0.9, 0.68])
    for start, end, label in [('2012', '2016', '2012–16 drought'), ('2020', '2022', '2020–22 drought')]:
        ax.axvspan(pd.Timestamp(f'{start}-01-01'), pd.Timestamp(f'{end}-12-31'), color=NEUTRAL, lw=0)
        middle = pd.Timestamp(f'{start}-01-01') + (pd.Timestamp(f'{end}-12-31') - pd.Timestamp(f'{start}-01-01')) / 2
        ax.text(middle, 0.995, label, transform=ax.get_xaxis_transform(),
                ha='center', va='top', color=INK_2, fontsize=9.5)
    ax.plot(s.date, s.ndvi, color=AXIS, lw=1.2, label='Every month')
    ax.plot(aug.date, aug.ndvi, color=BLUE, lw=2, marker='o', ms=4.5, label='August only')
    top = aug.nlargest(3, 'ndvi')
    low = aug.nsmallest(1, 'ndvi')
    for _, r in pd.concat([top, low]).iterrows():
        ax.annotate(f'{r.date.year}', (r.date, r.ndvi), xytext=(0, 8 if r.ndvi in top.ndvi.values else -14),
                    textcoords='offset points', ha='center', fontsize=9, color=INK_2)
    ax.set_ylabel('NDVI')
    ax.legend(loc='upper left', ncols=2, bbox_to_anchor=(0, 1.08))
    source(fig)
    save(fig, '1_statewide_ndvi.png')


def fig2_seasonal():
    s = pd.read_csv(DATA / 'ca_ndvi_statewide_monthly.csv', parse_dates=['date'])
    s['month'] = s.date.dt.month
    stats = s.groupby('month').ndvi.agg(['mean', 'min', 'max', 'std'])
    fig = plt.figure(figsize=(9, 5.2))
    titled(fig, 'California is greenest in spring and browns through summer',
           'Statewide NDVI by month: line = average year, band = lowest to highest year (2000–2026)')
    ax = fig.add_axes([0.08, 0.13, 0.88, 0.68])
    ax.fill_between(stats.index, stats['min'], stats['max'], color=BLUE_RAMP[0], lw=0,
                    label='Range across years')
    ax.plot(stats.index, stats['mean'], color=BLUE, lw=2, marker='o', ms=4.5, label='Average year')
    aug = stats.loc[8]
    march = stats.loc[3]
    ax.annotate(f"August years differ by at most {aug['max'] - aug['min']:.2f}\n"
                f"(March: {march['max'] - march['min']:.2f}), so August is the steadier baseline",
                (8, aug['mean']), xytext=(8, aug['max'] + 0.04), ha='center', fontsize=9.5,
                color=INK_2, arrowprops=dict(arrowstyle='-', color=MUTED, lw=0.8))
    ax.set_xticks(range(1, 13), ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                                 'Oct', 'Nov', 'Dec'])
    ax.set_ylabel('NDVI')
    ax.legend(loc='upper right', ncols=2, bbox_to_anchor=(1, 1.08))
    source(fig)
    save(fig, '2_seasonal_cycle.png')
    return stats


def fig3_burned_acres():
    a = pd.read_csv(DATA / 'ca_burned_acres_by_year.csv')
    a = a[(a.year >= 2001) & (a.year <= 2025)]
    fig = plt.figure(figsize=(11, 5.2))
    titled(fig, '2017–2021 brought the largest fire years since 2000',
           'Acres burned in California each year, from MODIS burned-area data (MCD64A1), '
           'which counted 10–27% fewer acres than official totals in 2017, 2018, 2020 and 2021')
    ax = fig.add_axes([0.08, 0.13, 0.9, 0.68])
    ax.bar(a.year, a.acres / 1e6, color=BLUE, width=0.72)
    for _, r in a.nlargest(3, 'acres').iterrows():
        ax.text(r.year, r.acres / 1e6 + 0.05, f'{r.acres / 1e6:.1f}M', ha='center', va='bottom',
                fontsize=9.5, color=INK_2)
    ax.set_ylabel('Million acres')
    ax.set_xticks(range(2001, 2026, 2))
    ax.grid(axis='x', visible=False)
    source(fig, 'Source: NASA MODIS MCD64A1 burned area via ORNL DAAC. 500 m pixels; small fires are missed.')
    save(fig, '3_burned_acres_by_year.png')


def fig4_burn_map():
    last = np.load(DATA / 'ca_last_burn_year_001.npz')['last_burn'].astype(float)
    last[last < 2001] = np.nan
    fig = plt.figure(figsize=(8, 9))
    titled(fig, 'Where California has burned since 2001',
           'Each 1 km cell colored by the most recent year at least half of it burned')
    ax = map_axes(fig, [0.03, 0.08, 0.8, 0.8])
    for ring in california_rings():
        ax.fill(ring[:, 0], ring[:, 1], color=LAND, lw=0)
    bounds = [a for a, _ in ERAS] + [ERAS[-1][1] + 1]
    cmap = ListedColormap(ERA_COLORS)
    image = ax.imshow(last, extent=(WEST, EAST, SOUTH, NORTH), cmap=cmap,
                      norm=BoundaryNorm(bounds, cmap.N), interpolation='nearest', zorder=2)
    draw_outline(ax)
    cax = fig.add_axes([0.84, 0.3, 0.025, 0.4])
    bar = fig.colorbar(image, cax=cax)
    bar.set_ticks([(a + b + 1) / 2 for a, b in ERAS], labels=[f'{a}–{b}' for a, b in ERAS])
    bar.outline.set_visible(False)
    bar.ax.tick_params(length=0, labelsize=9)
    source(fig, 'Source: NASA MODIS MCD64A1 burned area via ORNL DAAC, Nov 2000 – Jul 2026')
    save(fig, '4_burn_map.png')


def fig5_recovery():
    rec = pd.read_csv(DATA / 'fire_recovery.csv')
    fires = pd.read_csv(DATA / 'fires_summary.csv')
    n = len(fires)
    cols = 3
    rows_n = math.ceil(n / cols)
    fig, axes = plt.subplots(rows_n, cols, figsize=(11, 3.1 * rows_n + 1.2), sharex=True, sharey=True)
    fig.subplots_adjust(left=0.08, right=0.97, top=1 - 1.25 / (3.1 * rows_n + 1.2), bottom=0.09,
                        hspace=0.45, wspace=0.12)
    titled(fig, 'Southern California fires have greened back up; Sierra and northern fires are still scarred',
           'August NDVI of burned land minus similar nearby land that never burned, '
           'relative to before the fire (0 = fully recovered)')
    for ax, (_, f) in zip(axes.flat, fires.iterrows()):
        d = rec[rec.fire == f.fire]
        ax.axhline(0, color=AXIS, lw=1)
        ax.plot(d.years_since_fire, d.gap, color=BLUE, lw=2, marker='o', ms=3.5)
        last = d.iloc[-1]
        ax.annotate(f'{last.gap:+.2f}', (last.years_since_fire, last.gap), xytext=(4, 0),
                    textcoords='offset points', va='center', fontsize=9, color=INK_2)
        ax.set_title(f'{f.fire} ({f.start[:4]}) · {f.modis_acres / 1000:,.0f}k acres', loc='left',
                     fontsize=10.5, color=INK)
    for ax in axes.flat[n:]:
        ax.set_visible(False)
    for ax in axes[-1]:
        ax.set_xlabel('Years since fire')
    for ax in axes[:, 0]:
        ax.set_ylabel('NDVI gap')
    source(fig, 'Source: NASA MODIS Terra NDVI (GIBS) and MCD64A1 burned area (ORNL DAAC). '
                'Comparison land never burned in the MCD64A1 record.')
    save(fig, '5_recovery_by_fire.png')


def fig6_change_map(year=2025):
    data = np.load(DATA / 'ca_ndvi_change_001.npz')
    years = list(data['years'])
    change = data['change'][years.index(year)].astype(float)
    fig = plt.figure(figsize=(8, 9))
    titled(fig, f'Burn scars stand out once wet and dry years are removed (August {year})',
           "Each cell's NDVI compared with its own pre-fire normal and with nearby unburned land.\n"
           'Speckle in the Central and Imperial valleys is farmland changing crops, not fire.')
    ax = map_axes(fig, [0.03, 0.08, 0.8, 0.8])
    # Brown for less green, green for greener. The green steps match the brown steps in
    # lightness so equal changes look equally strong. Brown and green can be hard to tell
    # apart for red-green colorblind readers, so the color bar labels carry the meaning too.
    cmap = LinearSegmentedColormap.from_list(
        'change', ['#8c510a', '#d8b365', '#f6e8c3', NEUTRAL, '#e2f1d2', '#8fc66b', '#3a7d1f'])
    image = ax.imshow(change, extent=(WEST, EAST, SOUTH, NORTH), cmap=cmap, vmin=-0.2, vmax=0.2,
                      interpolation='nearest')
    draw_outline(ax)
    fires = pd.read_csv(DATA / 'fires_summary.csv')
    from analyze import FIRES
    seeds = {name: (lat, lon) for name, lat, lon, *_ in FIRES}
    # Labels sit outside the state so they never cover a scar.
    label_at = {'Dixie': (-118.4, 41.3), 'Camp': (-118.4, 40.3), 'Rim': (-117.2, 38.8),
                'Creek': (-116.6, 37.8), 'Thomas': (-121.8, 33.4)}
    for name, (x, y) in label_at.items():
        if name in set(fires.fire):
            lat, lon = seeds[name]
            note = ' (greened back up)' if name == 'Thomas' else ''
            ax.annotate(f'{name} {fires.set_index("fire").start[name][:4]}{note}', (lon, lat),
                        xytext=(x, y), fontsize=9, color=INK, ha='left',
                        arrowprops=dict(arrowstyle='-', color=INK_2, lw=0.7))
    cax = fig.add_axes([0.83, 0.3, 0.025, 0.4])
    bar = fig.colorbar(image, cax=cax, extend='both')
    bar.set_ticks([-0.2, -0.1, 0, 0.1, 0.2],
                  labels=['−0.2 less green', '−0.1', '0 normal', '+0.1', '+0.2 greener'])
    bar.outline.set_visible(False)
    bar.ax.tick_params(length=0, labelsize=9)
    source(fig)
    save(fig, f'6_change_map_{year}.png')


def fig7_scarred_area():
    s = pd.read_csv(DATA / 'ca_scarred_area_by_fire_year.csv')
    s = s[s.burn_year >= 2001]
    s['era'] = pd.cut(s.burn_year, [a - 0.5 for a, _ in ERAS] + [ERAS[-1][1] + 0.5],
                      labels=[f'{a}–{b}' for a, b in ERAS])
    table = s.pivot_table(index='august', columns='era', values='scarred_acres', aggfunc='sum',
                          observed=False).fillna(0) / 1e6
    fig = plt.figure(figsize=(11, 5.6))
    titled(fig, 'About half the land burned since 2001 is still less green than normal',
           'Acres more than 0.05 NDVI below normal each August, stacked by when the land last burned')
    ax = fig.add_axes([0.08, 0.12, 0.72, 0.68])
    ax.stackplot(table.index, table.T.values, colors=ERA_COLORS, labels=table.columns,
                 edgecolor=SURFACE, linewidth=1.2)
    handles, labels = ax.get_legend_handles_labels()
    ax.legend(handles[::-1], labels[::-1], title='Last burned', loc='upper left',
              bbox_to_anchor=(1.01, 1), fontsize=9.5, title_fontsize=9.5)
    ax.set_ylabel('Million acres still scarred')
    ax.set_xlim(table.index.min(), table.index.max())
    source(fig, 'Source: NASA MODIS Terra NDVI (GIBS) and MCD64A1 burned area (ORNL DAAC)')
    save(fig, '7_scarred_area_prototype.png')
    return table


if __name__ == '__main__':
    FIGURES.mkdir(exist_ok=True)
    fig2_seasonal()
    fig3_burned_acres()
    fig4_burn_map()
    fig6_change_map()
    fig7_scarred_area()
