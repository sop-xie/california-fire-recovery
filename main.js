// Main chart. Overview: one bar per fire year, split by
// its status as of the August on the slider. Clicking a bar zooms into it: the bar grows to
// fill the chart height, the others slide off the edges, and a map of the same land slides in beside it.
// The slider drives both, so you can watch one fire year's land recover on the bar and the map.
// The URL hash keeps the view, e.g. #year=2023&burn=2020&mode=share.

const COLORS = {
  scarred: '#aa4738',    // faded brick red, like a scar: still more than 0.05 NDVI below normal
  recovered: '#8fc66b',  // light green: back within 0.05 of normal
  reburned: '#8a8780',   // mid gray: burned again, now counted under the later fire
};
const PENDING = '#d6d4cc'; // not checked yet: the August shown comes before the first check
const PART_LABELS = { scarred: 'Still scarred', recovered: 'Recovered', reburned: 'Burned again later' };
const PARTS = ['scarred', 'recovered', 'reburned'];  // bottom to top
const MAP_STATUS = {
  s: { label: 'Still scarred', color: COLORS.scarred },
  r: { label: 'Recovered', color: COLORS.recovered },
  b: { label: 'Burned again later', color: COLORS.reburned },
};
const MAP_PENDING = { label: 'Not checked yet', color: '#b4b2a9' };
const LAND = '#ecebe6';
const OUTLINE = '#52514e';
const MARGIN = { top: 32, right: 16, bottom: 44, left: 64 };
const MIN_HEIGHT = 460;
const MAX_HEIGHT = 780;
const ZOOM_LABEL_ROOM = 190;  // px for the part labels between the zoomed bar and the map
const FIT_MIN_HEIGHT = 340;  // px; on short windows the page scrolls instead
const FIT_BOTTOM_GAP = 40;   // px between the chart and the alert bar (screen padding and bezel)
const NEAR_BAR = 28;        // px above a bar's top that still counts as hovering it (covers its % label)
const MIN_LABEL_BAND = 18;
const MAX_LABEL_FONT = 16;
const MIN_LABEL_FONT = 11;
const ZOOM_LABEL_FONT = 26;   // percent above the zoomed bar
const ZOOM_BAR_LEFT = 28;     // px from the y axis to the zoomed bar
const ZOOM_LABEL_GAP = 44;    // px between the part labels beside the zoomed bar
const PLAY_STEP_MS = 600;  // ms per year while playing
const SLIDER_THUMB = 20;  // px; must match the thumb size in style.css
const MOTION = {
  drag: { duration: 180, ease: d3.easeCubicOut },
  play: { duration: PLAY_STEP_MS, ease: d3.easeLinear },
  mode: { duration: 450, ease: d3.easeCubicInOut },
  zoom: { duration: 750, ease: d3.easeCubicInOut },
};
const MAX_ZOOM = 12;
const ACRES_PER_KM2 = 247.105;
const DATA_VERSION = 3;

const formatAcres = (acres) =>
  acres >= 1e6 ? `${d3.format('.2~f')(acres / 1e6)}M` :
  acres >= 1e3 ? `${d3.format('.0f')(acres / 1e3)}K` : d3.format(',')(Math.round(acres));
const formatPercent = d3.format('.0%');
const row = (label, value) => `<div class="row"><span>${label}</span><span>${value}</span></div>`;
// Text versions of the legend colors: the same hues, darkened where the bar color is too light
// to read as text.
const TEXT_COLORS = { scarred: COLORS.scarred, recovered: 'var(--recovered-text)', reburned: '#6e6b65' };
// A tooltip row whose label and number are written in its legend color.
const partRow = (part, value) => `<div class="row part" style="color:${TEXT_COLORS[part]}">`
  + `<span>${PART_LABELS[part]}</span><span>${value}</span></div>`;

// ---------- State ----------

let augusts = [];
let burnYears = [];
let status = null;     // burn year -> August -> { scarred, recovered, reburned }
let firstTotal = null; // burn year -> acres at its first check
let year = null;       // August shown on the chart and the map
let zoomed = null;     // burn year zoomed into, or null for the overview
let mode = 'acres';    // bar height: 'acres' or 'share'
let playTimer = null;
let layout = null;     // positions from the last render, for hover and the map box

const sliders = d3.selectAll('.year-slider');
const yearLabels = d3.selectAll('.year-label');
const playButtons = d3.selectAll('.play');

// ---------- Chart ----------

const chart = d3.select('#chart');
const tooltip = d3.select('#tooltip');
const svg = chart.append('svg');
const clipId = 'plot-clip';
const clipRect = svg.append('defs').append('clipPath').attr('id', clipId).append('rect');
const plot = svg.append('g');
const gridLayer = plot.append('g').attr('class', 'grid');
const barsGroup = plot.append('g').attr('clip-path', `url(#${clipId})`);
const labelsGroup = plot.append('g').attr('clip-path', `url(#${clipId})`);
const partsGroup = plot.append('g');
// Year labels under the bars are drawn by hand (not d3.axisBottom) so they travel with the
// bars when zooming in and out.
const baseline = plot.append('line').attr('class', 'baseline');
const yearTicks = plot.append('g').attr('class', 'year-ticks').attr('clip-path', `url(#${clipId})`);
const yAxisGroup = plot.append('g').attr('class', 'axis');
const yLabel = plot.append('text').attr('class', 'axis-label').attr('text-anchor', 'middle');
const xLabel = plot.append('text').attr('class', 'axis-label').attr('text-anchor', 'middle');
// "Click a bar" note with a curved arrow to the tallest bar (drawn before the hit area so
// clicks still reach the bars).
svg.append('defs').append('marker')
  .attr('id', 'note-arrow').attr('viewBox', '0 0 12 12').attr('refX', 9).attr('refY', 6)
  .attr('markerUnits', 'userSpaceOnUse').attr('markerWidth', 16).attr('markerHeight', 16)
  .attr('orient', 'auto-start-reverse')
  .append('path').attr('d', 'M3,2L9,6L3,10').attr('class', 'click-note-head');
const clickNote = plot.append('g').attr('class', 'click-note needs-attention').style('opacity', 0);
const clickNoteArrow = clickNote.append('path').attr('marker-end', 'url(#note-arrow)');
const clickNoteText = clickNote.append('text').attr('text-anchor', 'end')
  .text('Click a bar to watch that year recover');
const hoverOutline = plot.append('rect').attr('class', 'hover-outline').style('display', 'none');
let noteSpot = null;  // { burnYear, side } the click note points at now
const hitArea = plot.append('rect').attr('fill', 'transparent');

Promise.all([
  d3.csv(`data/scarred_area.csv?v=${DATA_VERSION}`, d3.autoType),
  d3.json(`data/map/meta.json?v=${DATA_VERSION}`),
  d3.json(`data/california.json?v=${DATA_VERSION}`),
]).then(([rows, meta, rings]) => {
  augusts = [...new Set(rows.map((d) => d.august))].sort((a, b) => a - b);
  burnYears = meta.burnYears;
  status = new Map(burnYears.map((b) => [b, new Map()]));
  for (const d of rows) {
    status.get(d.burn_year).set(d.august, {
      scarred: d.scarred_acres,
      recovered: d.burned_acres - d.scarred_acres,
      reburned: d.reburned_acres,
    });
  }
  firstTotal = new Map(burnYears.map((b) => [b, total(statusAt(b, b + 1))]));

  d3.select('#legend').html([...PARTS].reverse().map((part) =>
    `<li><span class="swatch" style="background:${COLORS[part]}"></span>${PART_LABELS[part]}</li>`).join(''));
  sliders.attr('min', augusts[0]).attr('max', augusts[augusts.length - 1])
    .on('input', (event) => {
      stopSliderCue();
      const picked = Math.round(+event.target.value);  // read before stopPlay resets the thumb
      stopPlay();
      setYear(picked, true);
    });
  playButtons.on('click', () => { stopSliderCue(); togglePlay(); });
  d3.select('.slider-hint')
    .on('mouseenter', () => sliders.classed('glow', true))
    .on('mouseleave', () => sliders.classed('glow', false));
  d3.selectAll('.mode-buttons button').on('click', (event) => {
    mode = event.currentTarget.dataset.mode;
    renderBars('mode');
    writeHash();
  });
  d3.select('#back').on('click', () => zoomOut(true));
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && zoomed !== null) zoomOut(true); });

  setUpMap(meta, rings);
  window.addEventListener('hashchange', readHash);
  window.addEventListener('resize', () => { renderBars(null); resizeMap(); });
  // Text sizes (year tag, click note) change once the web fonts arrive; measure again then.
  document.fonts?.ready.then(() => renderBars(null));
  readHash();
});

function statusAt(burnYear, august) {
  return status.get(burnYear).get(august) ?? { scarred: 0, recovered: 0, reburned: 0 };
}
const total = (s) => s.scarred + s.recovered + s.reburned;
const checked = (burnYear) => year > burnYear;

function readHash() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const asked = +params.get('year');
  mode = params.get('mode') === 'share' ? 'share' : 'acres';
  year = augusts.includes(asked) ? asked : augusts[augusts.length - 1];
  const burn = +params.get('burn');
  if (burnYears.includes(burn)) zoomTo(burn, false, 'none');
  else zoomOut(false, 'none');
  setYear(year, false, 'none');
}

function writeHash() {
  const params = new URLSearchParams();
  params.set('year', year);
  if (zoomed !== null) params.set('burn', zoomed);
  if (mode === 'share') params.set('mode', 'share');
  history.replaceState(null, '', `#${params}`);
}

// The current year, shown large above the slider: a small "August" over the year itself.
// Big label above the slider. Overview: the August shown. Zoomed in: the fire year you picked
// (the August is then on the tag that rides on the slider thumb).
function showYear() {
  const [small, big] = zoomed === null ? ['August', year] : ['Burned in', zoomed];
  yearLabels.html(`<span class="year-month">${small}</span><span class="year-number">${big}</span>`)
    .attr('aria-label', `${small} ${big}`);
  // The tag on the slider thumb only adds something when zoomed in; in the overview it would
  // just repeat the big August year.
  d3.select('#thumb-year').property('hidden', zoomed === null);
}

// moveSlider is false during Play, which moves the slider itself (smoothly, between years).
function setYear(next, updateHash, motion = 'drag', moveSlider = true) {
  year = next;
  if (moveSlider) setSlider(year);
  showYear();
  renderBars(motion);
  updateMap();
  if (updateHash) writeHash();
}

// Zoomed in, the slider starts at the fire's first check: the August after the fire year.
// startOver: clicking a bar jumps the slider to that fire's first check, so Play shows the
// whole recovery. Opening a link with a year in it keeps that year.
function zoomTo(burnYear, updateHash, motion = 'zoom', startOver = false) {
  zoomed = burnYear;
  stopPlay();
  if (startOver || year <= burnYear) year = burnYear + 1;
  animateThumbYear();
  sliders.attr('min', burnYear + 1);
  setSlider(year);
  showYear();
  tooltip.property('hidden', true);
  d3.select('#back').property('hidden', false);
  renderBars(motion);
  d3.select('#zoom-map').classed('visible', true);
  resizeMap();
  loadBurnYear(burnYear);
  if (updateHash) writeHash();
}

function zoomOut(updateHash, motion = 'zoom') {
  zoomed = null;
  cells = null;
  loadToken += 1;
  sliders.attr('min', augusts[0]);
  animateThumbYear();
  setSlider(year);
  showYear();
  tooltip.property('hidden', true);
  mapTooltip.property('hidden', true);
  d3.select('#back').property('hidden', true);
  d3.select('#zoom-map').classed('visible', false);
  renderBars(motion);
  if (updateHash) writeHash();
}

// Bar segments for one fire year, bottom to top, in acres or as a share of the bar.
function segments(burnYear) {
  if (!checked(burnYear)) {
    const height = mode === 'share' ? 1 : firstTotal.get(burnYear);
    return [{ burnYear, part: 'pending', y0: 0, y1: height }];
  }
  const s = statusAt(burnYear, year);
  const scale = mode === 'share' ? 1 / (total(s) || 1) : 1;
  let y0 = 0;
  return PARTS.map((part) => {
    const segment = { burnYear, part, y0, y1: y0 + s[part] * scale, acres: s[part] };
    y0 = segment.y1;
    return segment;
  });
}

const recoveredShare = (burnYear) => {
  const s = statusAt(burnYear, year);
  const counted = s.scarred + s.recovered;
  return counted ? s.recovered / counted : null;
};

// Where things go: in the overview every bar shares the width; zoomed in, the chosen bar
// sits on the left at a fixed width, its labels beside it, and the map fills the rest.
function computeLayout() {
  const width = chart.node().clientWidth;
  // Broadcast theme: fit the chart in the space between its top and the alert bar along the
  // bottom of the window, so the whole graphic is on screen without scrolling.
  const chartTop = chart.node().getBoundingClientRect().top + window.scrollY;
  const alertBar = document.querySelector('.alert-bar');
  const below = (alertBar ? alertBar.offsetHeight : 0) + FIT_BOTTOM_GAP;
  const height = Math.round(Math.max(FIT_MIN_HEIGHT, Math.min(MAX_HEIGHT, window.innerHeight - chartTop - below)));
  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;
  const band = d3.scaleBand().domain(burnYears).range([0, innerWidth]).paddingInner(0.2).paddingOuter(0.1);

  // California is taller than wide; leave room for it at full chart height when possible.
  const mapAspect = grid ? (grid.cols * Math.cos(((grid.north - grid.rows * grid.res / 2) * Math.PI) / 180)) / grid.rows : 0.87;
  // Broadcast theme: the map takes all the width right of the bar and its labels, which leaves
  // room beside California for the hint and city names.
  const barWidth = Math.max(60, Math.min(140, innerWidth * 0.12));
  const mapLeft = Math.min(ZOOM_BAR_LEFT + barWidth + ZOOM_LABEL_ROOM, innerWidth - innerHeight * mapAspect);
  const mapWidth = innerWidth - mapLeft;

  // Zoomed in, the chosen bar moves to the left and widens, and the others are spread far
  // enough apart that every one of them ends up past an edge of the chart, so they slide off
  // as the bar grows instead of fading.
  let barX = band;
  let barW = band.bandwidth();
  if (zoomed !== null) {
    const spread = Math.max(barWidth / band.bandwidth(), (innerWidth + barWidth) / band.step());
    barX = (b) => (band(b) - band(zoomed)) * spread + ZOOM_BAR_LEFT;
    barW = barWidth;
  }
  return { width, height, innerWidth, innerHeight, band, barX, barW, barWidth, mapLeft, mapWidth };
}

function renderBars(motion) {
  if (year === null) return;
  // Text first: it can change the height of the row above the slider, and the map and
  // slider are positioned from the layout measured below.
  updateTitle();
  layout = computeLayout();
  const { width, height, innerWidth, innerHeight, band, barX, barW } = layout;
  svg.attr('viewBox', `0 0 ${width} ${height}`);
  plot.attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);
  clipRect.attr('x', 0).attr('y', -MARGIN.top).attr('width', innerWidth)
    .attr('height', innerHeight + MARGIN.top + MARGIN.bottom);
  d3.selectAll('.mode-buttons button').attr('aria-pressed', function () { return this.dataset.mode === mode; });

  const { duration, ease } = MOTION[motion] ?? { duration: 0, ease: d3.easeLinear };
  // Returns the transition (not the selection), so the attributes set after it animate.
  const step = (selection) => selection.transition().duration(duration).ease(ease);

  const top = mode === 'share' ? 1
    : zoomed !== null ? firstTotal.get(zoomed) : d3.max(burnYears, (b) => firstTotal.get(b));
  const y = d3.scaleLinear().domain([0, top]).nice().range([innerHeight, 0]);
  layout.y = y;

  step(gridLayer).call(d3.axisLeft(y).ticks(5).tickSize(-innerWidth).tickFormat(''));
  step(yAxisGroup).call(d3.axisLeft(y).ticks(5)
    .tickFormat(mode === 'share' ? formatPercent : (v) => (v === 0 ? '0' : formatAcres(v))));
  yLabel.attr('transform', `translate(${-48},${innerHeight / 2}) rotate(-90)`)
    .text(mode === 'share' ? 'Proportion of the fire year\'s land' : 'Acres burned that year');
  xLabel.attr('x', innerWidth / 2).attr('y', innerHeight + 38).text(zoomed === null ? 'Year of the fire' : '');
  baseline.attr('x1', 0).attr('x2', innerWidth).attr('y1', innerHeight).attr('y2', innerHeight);

  // Year labels ride along with their bars. The overview shows every few years so they fit;
  // zoomed in, the chosen year reads "Fires of 2020" under its bar.
  const every = Math.ceil(burnYears.length / Math.max(2, Math.floor(innerWidth / 50)));
  const ticks = yearTicks.selectAll('text')
    .data(burnYears, (b) => b)
    .join((enter) => enter.append('text').attr('text-anchor', 'middle').attr('x', (b) => barX(b) + barW / 2))
    .attr('y', innerHeight + 18)
    .classed('zoomed-year', (b) => b === zoomed)
    .text((b) => (b === zoomed ? `Fires of ${b}` : b))
    .style('display', (b, i) => (zoomed !== null || i % every === 0 ? null : 'none'));
  step(ticks).attr('x', (b) => barX(b) + barW / 2);

  // Bars: existing pieces glide to their new place and size (this is the zoom); pieces that
  // appear or disappear when a fire year gets its first check fade in place.
  const bars = barsGroup.selectAll('rect')
    .data(burnYears.flatMap(segments), (d) => `${d.burnYear}-${d.part}`)
    .join(
      (enter) => enter.append('rect')
        .attr('x', (d) => barX(d.burnYear))
        .attr('width', barW)
        .attr('y', (d) => y(d.y1))
        .attr('height', (d) => y(d.y0) - y(d.y1))
        .style('opacity', 0),
      (update) => update,
      (exit) => exit.transition().duration(duration).ease(ease).style('opacity', 0).remove(),
    )
    .attr('class', 'bar')
    .attr('fill', (d) => (d.part === 'pending' ? PENDING : COLORS[d.part]));
  // Pieces that are appearing (faded out, or still fading out from an earlier change) jump
  // straight to their new place and size and only fade in, so nothing grows from the bottom.
  // Pieces already showing glide to their new size as before.
  // (Mostly invisible = appearing; a piece that has nearly finished fading in keeps gliding.)
  const appearing = (selection) => selection.filter(function () { return +(this.style.opacity || 1) < 0.5; });
  appearing(bars).interrupt()
    .attr('x', (d) => barX(d.burnYear))
    .attr('width', barW)
    .attr('y', (d) => y(d.y1))
    .attr('height', (d) => y(d.y0) - y(d.y1));
  step(bars)
    .style('opacity', 1)
    .attr('x', (d) => barX(d.burnYear))
    .attr('width', barW)
    .attr('y', (d) => y(d.y1))
    .attr('height', (d) => y(d.y0) - y(d.y1));

  // Green percent above each checked bar; zoomed in, only the chosen bar's, and bigger.
  const labelYears = band.bandwidth() >= MIN_LABEL_BAND || zoomed !== null ? burnYears.filter(checked) : [];
  const smallFont = Math.max(MIN_LABEL_FONT, Math.min(MAX_LABEL_FONT, band.step() * 0.38));
  const labelY = (b) => y(d3.max(segments(b), (d) => d.y1)) - 6;
  const labels = labelsGroup.selectAll('text')
    .data(labelYears, (b) => b)
    .join(
      (enter) => enter.append('text')
        .attr('x', (b) => barX(b) + barW / 2)
        .attr('y', labelY)
        .style('opacity', 0),
      (update) => update,
      (exit) => exit.transition().duration(duration).ease(ease).style('opacity', 0).remove(),
    )
    .attr('class', 'bar-label')
    .attr('text-anchor', 'middle')
    .text((b) => (recoveredShare(b) === null ? '' : formatPercent(recoveredShare(b))));
  appearing(labels).interrupt()
    .attr('x', (b) => barX(b) + barW / 2)
    .attr('y', labelY);
  step(labels)
    .style('opacity', 1)
    .style('font-size', (b) => `${b === zoomed ? ZOOM_LABEL_FONT : smallFont}px`)
    .attr('x', (b) => barX(b) + barW / 2)
    .attr('y', labelY);

  renderPartLabels(y, step, motion === 'zoom' ? duration : 0);

  // The click note only shows in the overview with bars in acres; with proportions every bar
  // is full height and there's no room (the bar tooltip still says "click").
  noteSpot = null;
  placeClickNote(restingNote(), 0);
  hoverOutline.style('display', 'none');
  clickNote.transition('show').duration(zoomed === null ? 300 : 150)
    .style('opacity', zoomed === null && mode === 'acres' ? 1 : 0);

  hitArea.attr('width', innerWidth).attr('height', innerHeight)
    .on('pointermove', hover)
    .on('pointerleave', () => {
      tooltip.property('hidden', true);
      hoverOutline.style('display', 'none');
    })
    .on('click', (event) => {
      const burnYear = burnAt(event);
      if (burnYear === null || zoomed !== null) return;
      clickNote.classed('needs-attention', false);
      stopPlay();
      zoomTo(burnYear, true, 'zoom', true);
    });

  placeMap();
  placeSlider();
  // Broadcast theme: lets broadcast.js refresh the sidebar readouts.
  document.dispatchEvent(new Event('chartchange'));
}

// Zoomed in: name each part of the bar beside it, with its acres and share. After a zoom the
// labels wait until the bar has finished growing (delay), then appear.
function renderPartLabels(y, step, delay) {
  let items = [];
  if (zoomed !== null) {
    const left = ZOOM_BAR_LEFT + layout.barWidth;
    if (!checked(zoomed)) {
      items = [{ key: 'pending', name: 'Not checked yet', value: `First check: August ${zoomed + 1}`,
        anchor: y(mode === 'share' ? 0.5 : firstTotal.get(zoomed) / 2) }];
    } else {
      const counted = statusAt(zoomed, year).scarred + statusAt(zoomed, year).recovered;
      items = segments(zoomed).filter((d) => d.acres > 0).reverse().map((d) => ({
        key: d.part,
        name: PART_LABELS[d.part],
        value: d.part === 'reburned' ? `${formatAcres(d.acres)} acres`
          : `${formatAcres(d.acres)} acres · ${formatPercent(d.acres / counted)}`,
        anchor: (y(d.y0) + y(d.y1)) / 2,
      }));
    }
    // Keep labels from overlapping: push each one below the last, then pull up if needed.
    let previous = -Infinity;
    for (const item of items) {
      item.y = Math.max(item.anchor, previous + ZOOM_LABEL_GAP);
      previous = item.y;
    }
    const overflow = previous - (layout.innerHeight - 10);
    if (overflow > 0) items.forEach((item) => { item.y -= overflow; });
    items.forEach((item) => { item.x = left; });
  }

  const groups = partsGroup.selectAll('g.part-label')
    .data(items, (d) => d.key)
    .join(
      (enter) => {
        const g = enter.append('g').attr('class', 'part-label').style('opacity', 0)
          .attr('transform', (d) => `translate(${d.x},${d.y})`);
        g.append('path').attr('class', 'part-leader');
        g.append('text').attr('class', 'part-name').attr('x', 18).attr('dy', '-0.15em');
        g.append('text').attr('class', 'part-value').attr('x', 18).attr('dy', '1.1em');
        return g;
      },
      (update) => update,
      (exit) => exit.remove(),
    );
  // Label text in the part's color, except where that color is too light to read as text.
  groups.select('.part-name').text((d) => d.name)
    .style('fill', (d) => TEXT_COLORS[d.key] ?? 'var(--ink-2)');
  groups.select('.part-value').text((d) => d.value);
  step(groups.select('.part-leader')).attr('d', (d) => `M2,${d.anchor - d.y}L12,0`);
  step(groups).attr('transform', (d) => `translate(${d.x},${d.y})`);
  // A separately named transition, so it doesn't cancel the move above.
  groups.filter(function () { return +this.style.opacity < 1; })
    .transition('appear').delay(delay).duration(150).style('opacity', 1);
}

// Position the map box over the right part of the plot area.
function placeMap() {
  const { mapLeft, mapWidth, innerHeight } = layout;
  const chartTop = chart.node().offsetTop;  // the slider sits above the chart in the same box
  d3.select('#zoom-map')
    .style('left', `${MARGIN.left + mapLeft}px`)
    .style('top', `${chartTop + MARGIN.top}px`)
    .style('width', `${mapWidth}px`)
    .style('height', `${innerHeight}px`);

  resizeMap();
}

// Line the slider up with the bars. In the overview each August's stop sits in the gap just
// right of the previous fire year's bar, so the bars left of the thumb are the ones checked by
// then and the gray bars are to its right. Zoomed in, the slider spans the whole plot.
function placeSlider() {
  const { band, innerWidth } = layout;
  const gapRight = (b) => band(b) + band.bandwidth() + (band.step() - band.bandwidth()) / 2;
  const start = zoomed === null ? gapRight(augusts[0] - 1) : 0;
  const end = zoomed === null ? gapRight(augusts[augusts.length - 1] - 1) : innerWidth;
  // The thumb's center can only travel from half a thumb in from each end of the input.
  sliderSpan = { left: MARGIN.left + start - SLIDER_THUMB / 2, width: end - start + SLIDER_THUMB };
  sliders
    .style('left', `${sliderSpan.left}px`)
    .style('width', `${sliderSpan.width}px`);
  placeThumbYear();
}

// Moves the slider thumb and shades the track up to it.
function setSlider(value) {
  sliders.property('value', value).each(function () {
    const span = (+this.max - +this.min) || 1;
    this.style.setProperty('--fill', `${((value - +this.min) / span) * 100}%`);
  });
  placeThumbYear();
}

// The year tag riding on the slider thumb. Its text is the year nearest the thumb, so during
// Play it changes as the thumb passes each year.
let sliderSpan = null;
const thumbYear = d3.select('#thumb-year');
function placeThumbYear() {
  const slider = sliders.node();
  if (!sliderSpan || !slider) return;
  const value = +slider.value;
  const span = (+slider.max - +slider.min) || 1;
  const center = sliderSpan.left + SLIDER_THUMB / 2 + ((value - +slider.min) / span) * (sliderSpan.width - SLIDER_THUMB);
  thumbYear.text(Math.round(value));
  // Center the tag on the thumb, but keep it inside the chart; its pointer still aims at the thumb.
  const tagWidth = thumbYear.node().offsetWidth;
  const trackWidth = thumbYear.node().parentNode.clientWidth;
  const left = Math.max(2, Math.min(trackWidth - tagWidth - 2, center - tagWidth / 2));
  thumbYear.style('left', `${left}px`).style('--pointer', `${center - left}px`);
}

// While the slider stretches or shrinks for a zoom, let the tag glide with it.
function animateThumbYear() {
  thumbYear.classed('gliding', true);
  setTimeout(() => thumbYear.classed('gliding', false), 800);
}

// The title stays fixed; the subtitle and the slider hint change between the two views.
function updateTitle() {
  if (zoomed !== null) {
    d3.select('#subtitle').text(`The land that burned in ${zoomed}, on the bar and on the map.`);
    d3.select('#slider-hint-text').text('Drag the slider to watch this land recover.');
    return;
  }
  d3.select('#subtitle').text('Each bar is one year\'s fires. Older fires have had more time to recover.');
  d3.select('#slider-hint-text').text('Drag the slider to see how much of each year had grown back.');
}

// The fire year whose bar is under (or just above) the pointer, or null. Empty space well
// above a bar doesn't count, so the tooltip only shows on or near the bars.
function burnAt(event) {
  const [mx, my] = d3.pointer(event);
  let burnYear = null;
  if (zoomed !== null) {
    if (mx >= ZOOM_BAR_LEFT && mx <= ZOOM_BAR_LEFT + layout.barWidth) burnYear = zoomed;
  } else {
    const { band } = layout;
    const index = Math.floor((mx - band(burnYears[0]) + (band.step() - band.bandwidth()) / 2) / band.step());
    if (index >= 0 && index < burnYears.length) burnYear = burnYears[index];
  }
  if (burnYear === null) return null;
  const barTop = layout.y(d3.max(segments(burnYear), (d) => d.y1));
  return my >= barTop - NEAR_BAR ? burnYear : null;
}

function hover(event) {
  const burnYear = burnAt(event);
  hitArea.style('cursor', burnYear !== null && zoomed === null ? 'pointer' : 'default');
  if (burnYear === null) {
    tooltip.property('hidden', true);
    hoverOutline.style('display', 'none');
    return;
  }
  let html = `<strong>Fires of ${burnYear}, as of August ${year}</strong>`;
  if (!checked(burnYear)) {
    html += row('Burned', `${formatAcres(firstTotal.get(burnYear))} acres`)
      + `<div class="row"><span>Not checked yet. First check: August ${burnYear + 1}</span></div>`;
  } else {
    const s = statusAt(burnYear, year);
    const counted = s.scarred + s.recovered;
    html += row('Burned', `${formatAcres(total(s))} acres`)
      + partRow('scarred', `${formatAcres(s.scarred)} (${formatPercent(counted ? s.scarred / counted : 0)})`)
      + partRow('recovered', `${formatAcres(s.recovered)} (${formatPercent(counted ? s.recovered / counted : 0)})`)
      + partRow('reburned', formatAcres(s.reburned));
  }
  tooltip.property('hidden', false).html(html);
  // Next to the mouse: below and to the right, flipping left or up near the chart's edges.
  const [mx, my] = d3.pointer(event, chart.node());
  const tipWidth = tooltip.node().offsetWidth;
  const tipHeight = tooltip.node().offsetHeight;
  const chartWidth = chart.node().clientWidth;
  const chartHeight = chart.node().clientHeight;
  const gap = 16;
  const left = mx + gap + tipWidth > chartWidth ? mx - gap - tipWidth : mx + gap;
  const tipTop = my + gap + tipHeight > chartHeight ? Math.max(0, my - gap - tipHeight) : my + gap;
  tooltip.style('left', `${left}px`).style('top', `${tipTop}px`);
  if (zoomed !== null) return;

  const { y, barX, barW, innerHeight } = layout;
  const top = y(d3.max(segments(burnYear), (d) => d.y1));
  hoverOutline.style('display', null)
    .attr('x', barX(burnYear) - 2).attr('width', barW + 4)
    .attr('y', top - 2).attr('height', innerHeight - top + 2);
}

// The click note stays put beside the tallest bar, on its left, where the chart is empty.
function restingNote() {
  const tallest = burnYears.reduce((a, b) => (firstTotal.get(b) > firstTotal.get(a) ? b : a));
  return { burnYear: tallest, side: 'left' };
}

// Point the click note at one bar. The text goes above the bar when there's room, otherwise
// beside it lower down, on the given side; the arrow curves from the text to the bar's edge.
function placeClickNote(spot, duration) {
  if (noteSpot && noteSpot.burnYear === spot.burnYear && noteSpot.side === spot.side) return;
  noteSpot = spot;
  const { y, barX, barW, innerWidth, innerHeight } = layout;
  const top = y(d3.max(segments(spot.burnYear), (d) => d.y1));
  // Keep the text inside the chart: switch sides if it would run off the edge, and as a last
  // resort (narrow screens) pull it back inside.
  const reach = 56;
  const textWidth = clickNoteText.node().getComputedTextLength();
  const leftEdge = barX(spot.burnYear) - 6;
  const rightEdge = barX(spot.burnYear) + barW + 6;
  const fits = (side) => (side === 'left' ? leftEdge - reach - textWidth >= 0
    : rightEdge + reach + textWidth <= innerWidth);
  const side = fits(spot.side) ? spot.side : (spot.side === 'left' ? 'right' : 'left');
  const dir = side === 'left' ? -1 : 1;
  const edge = side === 'left' ? leftEdge : rightEdge;
  const roomAbove = top - 70 >= 16;
  const tip = [edge, roomAbove ? Math.min(top + 8, innerHeight - 2) : top + 26];
  const textX = side === 'left' ? Math.max(textWidth, edge - reach) : Math.min(innerWidth - textWidth, edge + reach);
  const text = [textX, roomAbove ? top - 44 : top + 74];
  const start = [text[0] - dir * 6, text[1] - 6];
  const bend = [tip[0] + dir * 40, text[1] - 8];
  clickNoteText.attr('text-anchor', side === 'left' ? 'end' : 'start')
    .transition('move').duration(duration).ease(d3.easeCubicOut)
    .attr('x', text[0]).attr('y', text[1]);
  clickNoteArrow.transition('move').duration(duration).ease(d3.easeCubicOut)
    .attr('d', `M${start[0]},${start[1]}Q${bend[0]},${bend[1]} ${tip[0]},${tip[1]}`);
}

// The bobbing arrow and pulsing thumb stop once the reader has used the slider or Play.
function stopSliderCue() {
  sliders.classed('needs-attention', false);
  d3.select('.slider-hint').classed('needs-attention', false);
}

// ---------- Play ----------

function togglePlay() {
  if (playTimer) {
    stopPlay();
    return;
  }
  const first = augusts[0];
  const last = augusts[augusts.length - 1];
  if (year >= last) setYear(zoomed !== null ? Math.max(first, zoomed + 1) : first, true);
  playButtons.text('❚❚ Pause');

  // The slider thumb glides at a steady speed, one year per PLAY_STEP_MS, instead of jumping.
  // Each time it sets off toward the next year, the bars and map start their move to that
  // year too, so the bars arrive when the thumb does.
  const from = year;
  let target = from;
  sliders.attr('step', 'any');  // let the thumb rest between whole years while playing
  playTimer = d3.timer((elapsed) => {
    const position = Math.min(last, from + elapsed / PLAY_STEP_MS);
    setSlider(position);
    if (target < last && position >= target) {
      target += 1;
      setYear(target, true, 'play', false);
    }
    if (position >= last) stopPlay();
  });
}

function stopPlay() {
  if (!playTimer) return;
  playTimer.stop();
  playTimer = null;
  sliders.attr('step', 1);
  setSlider(year);  // settle on the year the bars are showing
  playButtons.text('▶ Watch it recover');
}

// ---------- Map of the zoomed fire year ----------

const mapBox = d3.select('#zoom-map');
const canvas = d3.select('#map-canvas');
const mapTooltip = d3.select('#map-tooltip');
const mapHint = d3.select('#map-hint');
const mapCache = new Map();

let grid = null;
let caPath = null;
let aspect = 1;
let cells = null;
let image = null;
let base = { scale: 1, ox: 0, oy: 0, width: 0, height: 0 };
let transform = d3.zoomIdentity;
let loadToken = 0;

// Close-ups of the biggest burn areas. A burn area is a group of burned cells no more than
// CLUSTER_GAP cells apart (so one fire's patchy scar counts as one area). The close-ups show
// when a fire year opens, with the whole state in view, and step aside once the reader zooms
// or drags the map; "Show all of California" brings them back.
// Cities shown for orientation: [name, latitude, longitude, label side].
const CITIES = [
  ['Redding', 40.59, -122.39, 'right'],
  ['Sacramento', 38.58, -121.49, 'right'],
  ['Fresno', 36.74, -119.79, 'right'],
  ['San Francisco', 37.77, -122.42, 'left'],
  ['Los Angeles', 34.05, -118.24, 'right'],
  ['San Diego', 32.72, -117.16, 'right'],
];
const MAP_SLACK = 0.4;          // share of the map's width/height it can be dragged past each edge
const CLUSTER_GAP = 2;          // grid cells
const MIN_SECOND_SHARE = 0.15;  // a second close-up only if that area is this share of the first
const AREA_PAD = 4;             // grid cells of margin around a burn area
const MIN_AREA_BOX = 14;        // grid cells: smallest box marked around a burn area
const CAPTION_H = 40;           // px under each close-up for its caption
const CUE = '#1f5fa8';          // same blue as the page's instructions
// Where the close-ups go, as fractions of California's bounding box: the empty space east of
// the state (Nevada), the bigger one at the top and the second one below it.
const INSET_SLOTS = [
  { x: 0.56, y: 0.01, w: 0.44, h: 0.31 },
  { x: 0.72, y: 0.35, w: 0.28, h: 0.27 },
];
let insets = [];      // close-ups from the last draw, for clicks and hover
let showInsets = true;

// A press that wobbles a few pixels (easy on a trackpad) still counts as a click, and the
// close-ups only step aside once the reader has really zoomed or dragged the map.
const CLICK_WOBBLE = 5;  // px
let gestureStart = null;
const zoom = d3.zoom()
  .scaleExtent([1, MAX_ZOOM])
  .clickDistance(CLICK_WOBBLE)
  .on('start', (event) => { gestureStart = event.transform; })
  .on('zoom', (event) => {
    transform = event.transform;
    const from = gestureStart ?? transform;
    const moved = Math.hypot(transform.x - from.x, transform.y - from.y) > CLICK_WOBBLE || transform.k !== from.k;
    if (event.sourceEvent && moved) showInsets = false;  // the reader is exploring the map themselves
    drawMap();
  });

function setUpMap(meta, rings) {
  grid = meta;
  const middleLat = grid.north - (grid.rows * grid.res) / 2;
  aspect = Math.cos((middleLat * Math.PI) / 180);
  caPath = new Path2D();
  for (const ring of rings) {
    ring.forEach(([lon, lat], i) => {
      const gx = (lon - grid.west) / grid.res;
      const gy = (grid.north - lat) / grid.res;
      if (i === 0) caPath.moveTo(gx, gy); else caPath.lineTo(gx, gy);
    });
    caPath.closePath();
  }
  image = document.createElement('canvas');
  image.width = grid.cols;
  image.height = grid.rows;
  d3.select('#reset-zoom').on('click', (event) => {
    event.currentTarget.hidden = true;
    canvas.transition().duration(600).call(zoom.transform, d3.zoomIdentity)
      .on('end', () => { showInsets = true; drawMap(); });
  });
  canvas.call(zoom)
    .on('pointermove', mapHover)
    .on('pointerleave', () => mapTooltip.property('hidden', true))
    .on('click', mapClick);
}

function loadBurnYear(burnYear) {
  const token = ++loadToken;
  cells = null;
  drawMap();
  const cached = mapCache.get(burnYear);
  const request = cached ? Promise.resolve(cached)
    : d3.json(`data/map/${burnYear}.json?v=${DATA_VERSION}`).then((data) => {
      const parsed = parseCells(data);
      parsed.areas = findBurnAreas(parsed);
      mapCache.set(burnYear, parsed);
      return parsed;
    });
  request.then((parsed) => {
    if (token !== loadToken) return;
    cells = parsed;
    showInsets = true;
    canvas.call(zoom.transform, d3.zoomIdentity);  // whole state; the close-ups do the zooming
    updateMap();
    document.dispatchEvent(new Event('chartchange'));
  });
}

function parseCells(data) {
  const count = data.cells.length;
  const rows = new Uint16Array(count);
  const cols = new Uint16Array(count);
  const area = new Float64Array(count);
  const index = new Map();
  const side = 111.195 * grid.res;
  data.cells.forEach(([r, c], i) => {
    rows[i] = r;
    cols[i] = c;
    const lat = grid.north - (r + 0.5) * grid.res;
    area[i] = side * side * Math.cos((lat * Math.PI) / 180) * ACRES_PER_KM2;
    index.set(r * grid.cols + c, i);
  });
  return { years: data.years, rows, cols, area, index, codes: data.cells.map((cell) => cell[2]) };
}

// The one or two biggest burn areas: groups of cells within CLUSTER_GAP of each other.
function findBurnAreas(parsed) {
  const count = parsed.rows.length;
  const seen = new Uint8Array(count);
  const areas = [];
  for (let start = 0; start < count; start += 1) {
    if (seen[start]) continue;
    seen[start] = 1;
    const members = [start];
    for (let k = 0; k < members.length; k += 1) {
      const r = parsed.rows[members[k]];
      const c = parsed.cols[members[k]];
      for (let dr = -CLUSTER_GAP; dr <= CLUSTER_GAP; dr += 1) {
        for (let dc = -CLUSTER_GAP; dc <= CLUSTER_GAP; dc += 1) {
          const j = parsed.index.get((r + dr) * grid.cols + (c + dc));
          if (j !== undefined && !seen[j]) {
            seen[j] = 1;
            members.push(j);
          }
        }
      }
    }
    let acres = 0;
    let [r0, r1, c0, c1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const i of members) {
      acres += parsed.area[i];
      r0 = Math.min(r0, parsed.rows[i]);
      r1 = Math.max(r1, parsed.rows[i] + 1);
      c0 = Math.min(c0, parsed.cols[i]);
      c1 = Math.max(c1, parsed.cols[i] + 1);
    }
    areas.push({ members, acres, r0, r1, c0, c1 });
  }
  areas.sort((a, b) => b.acres - a.acres);
  return areas.slice(0, 2).filter((a, i) => i === 0 || a.acres >= MIN_SECOND_SHARE * areas[0].acres);
}

// Grid box around a burn area, padded and stretched to the close-up's shape (width / height).
function areaBox(burnArea, shape) {
  let height = Math.max(burnArea.r1 - burnArea.r0 + 2 * AREA_PAD, MIN_AREA_BOX);
  let width = Math.max(burnArea.c1 - burnArea.c0 + 2 * AREA_PAD, MIN_AREA_BOX / aspect);
  if ((width * aspect) / height < shape) width = (height * shape) / aspect;
  else height = (width * aspect) / shape;
  const rMid = (burnArea.r0 + burnArea.r1) / 2;
  const cMid = (burnArea.c0 + burnArea.c1) / 2;
  return { r0: rMid - height / 2, r1: rMid + height / 2, c0: cMid - width / 2, c1: cMid + width / 2 };
}

// Zoom the main map onto a grid box.
function fitBox(box) {
  const toScreen = (c, r) => [base.ox + base.scale * aspect * c, base.oy + base.scale * r];
  const [x0, y0] = toScreen(box.c0, box.r0);
  const [x1, y1] = toScreen(box.c1, box.r1);
  const k = Math.min(MAX_ZOOM, 0.9 * Math.min(base.width / (x1 - x0), base.height / (y1 - y0)));
  return d3.zoomIdentity
    .translate(base.width / 2 - k * (x0 + x1) / 2, base.height / 2 - k * (y0 + y1) / 2)
    .scale(Math.max(1, k));
}

// The canvas fills the map box; California is fitted inside it.
function resizeMap() {
  if (!grid) return;
  const width = mapBox.node().clientWidth;
  const height = mapBox.node().clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.attr('width', Math.round(width * ratio)).attr('height', Math.round(height * ratio));
  const scale = Math.min(width / (grid.cols * aspect), height / grid.rows);
  base = {
    scale,
    width,
    height,
    ox: (width - grid.cols * aspect * scale) / 2,
    oy: (height - grid.rows * scale) / 2,
  };
  // Room to drag past California's edges, so the map can be moved even before zooming in.
  const slackX = width * MAP_SLACK;
  const slackY = height * MAP_SLACK;
  zoom.extent([[0, 0], [width, height]])
    .translateExtent([[-slackX, -slackY], [width + slackX, height + slackY]]);
  drawMap();
}

function updateMap() {
  if (!cells) return;
  paintCells();
  drawMap();
}

function codeAt(i) {
  const column = cells.years.indexOf(year);
  return column === -1 ? null : cells.codes[i][column];
}

function paintCells() {
  const context = image.getContext('2d');
  const pixels = context.createImageData(grid.cols, grid.rows);
  const rgb = (color) => { const c = d3.rgb(color); return [c.r, c.g, c.b]; };
  const colors = Object.fromEntries(Object.entries(MAP_STATUS).map(([code, s]) => [code, rgb(s.color)]));
  const pending = rgb(MAP_PENDING.color);
  const column = cells.years.indexOf(year);
  for (let i = 0; i < cells.codes.length; i += 1) {
    const color = column === -1 ? pending : colors[cells.codes[i][column]];
    if (!color) continue;
    const offset = (cells.rows[i] * grid.cols + cells.cols[i]) * 4;
    pixels.data[offset] = color[0];
    pixels.data[offset + 1] = color[1];
    pixels.data[offset + 2] = color[2];
    pixels.data[offset + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
}

// A view maps grid cells to screen pixels: x = tx + sx * col, y = ty + sy * row.
function mainView() {
  const k = transform.k * base.scale;
  return { sx: k * aspect, sy: k, tx: transform.x + transform.k * base.ox, ty: transform.y + transform.k * base.oy };
}

// Draw California and the burned cells through one view.
function drawView(context, ratio, view) {
  context.setTransform(ratio * view.sx, 0, 0, ratio * view.sy, ratio * view.tx, ratio * view.ty);
  context.fillStyle = LAND;
  context.fill(caPath);
  if (cells) {
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
  }
  context.strokeStyle = OUTLINE;
  context.lineWidth = 1 / view.sy;
  context.stroke(caPath);
}

function drawMap() {
  if (!grid) return;
  const context = canvas.node().getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = '#fcfcfb';
  context.fillRect(0, 0, canvas.node().width, canvas.node().height);
  const view = mainView();
  drawView(context, ratio, view);
  drawCities(context, ratio, view);
  insets = showInsets && cells ? layoutInsets(view) : [];
  // Lines first, then every close-up on top, so no line crosses over a close-up.
  insets.forEach((inset) => drawLeaders(context, ratio, inset));
  insets.forEach((inset) => drawInset(context, ratio, inset));
  mapHint.text(insets.length
    ? 'The blue boxes magnify the biggest burn areas. Click one to zoom in, or scroll on the map.'
    : 'Scroll to zoom and drag to move. "All of California" brings the close-ups back.');
  // The way back only appears once the reader has zoomed, dragged or clicked a close-up.
  d3.select('#reset-zoom').property('hidden', showInsets || !cells);
}

// Black dots and names for a few cities, the same size at any zoom. A light outline around
// the text keeps it readable over burned cells.
function drawCities(context, ratio, view) {
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.font = '700 14px "Barlow Condensed", "Arial Narrow", sans-serif';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  for (const [name, lat, lon, side] of CITIES) {
    const x = view.tx + view.sx * ((lon - grid.west) / grid.res);
    const y = view.ty + view.sy * ((grid.north - lat) / grid.res);
    context.fillStyle = '#0b0b0b';
    context.beginPath();
    context.arc(x, y, 3.5, 0, 2 * Math.PI);
    context.fill();
    context.textAlign = side === 'left' ? 'right' : 'left';
    const tx = side === 'left' ? x - 7 : x + 7;
    context.strokeStyle = 'rgb(252 252 251 / 85%)';
    context.lineWidth = 3;
    context.strokeText(name, tx, y);
    context.fillText(name, tx, y);
  }
  context.textAlign = 'left';
}

// Place a close-up for each big burn area, with the box it magnifies on the main map.
function layoutInsets(view) {
  const caWidth = grid.cols * aspect * base.scale;
  const caHeight = grid.rows * base.scale;
  // The area farther north gets the top close-up, so the connecting lines don't cross.
  const byNorth = [...cells.areas].sort((a, b) => (a.r0 + a.r1) - (b.r0 + b.r1));
  return cells.areas.map((burnArea, i) => {
    const slot = INSET_SLOTS[byNorth.indexOf(burnArea)];
    const x = base.ox + slot.x * caWidth;
    // Stretch each close-up to the map's right edge, using the empty space beside California.
    const frame = { x, y: base.oy + slot.y * caHeight, w: Math.max(slot.w * caWidth, base.width - 6 - x), h: slot.h * caHeight };
    const content = { x: frame.x + 1, y: frame.y + 1, w: frame.w - 2, h: frame.h - CAPTION_H - 1 };
    const box = areaBox(burnArea, content.w / content.h);
    const mark = {
      x: view.tx + view.sx * box.c0,
      y: view.ty + view.sy * box.r0,
      w: view.sx * (box.c1 - box.c0),
      h: view.sy * (box.r1 - box.r0),
    };
    const sx = content.w / (box.c1 - box.c0);
    const sy = content.h / (box.r1 - box.r0);
    const inner = { sx, sy, tx: content.x - sx * box.c0, ty: content.y - sy * box.r0 };
    return { burnArea, rank: i, frame, content, box, mark, view: inner };
  });
}

// Box on the map and the two lines out to its close-up, along the outside of both boxes.
function drawLeaders(context, ratio, inset) {
  const { frame, mark } = inset;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const corners = (b) => ({ tl: [b.x, b.y], tr: [b.x + b.w, b.y], bl: [b.x, b.y + b.h], br: [b.x + b.w, b.y + b.h] });
  const a = corners(mark);
  const b = corners(frame);
  const right = frame.x + frame.w / 2 > mark.x + mark.w / 2;
  const up = frame.y + frame.h / 2 < mark.y + mark.h / 2;
  const pairs = right === up ? ['tl', 'br'] : ['tr', 'bl'];
  context.strokeStyle = CUE;
  context.lineWidth = 1.2;
  context.beginPath();
  for (const p of pairs) {
    context.moveTo(...a[p]);
    context.lineTo(...b[p]);
  }
  context.stroke();
  context.lineWidth = 2;
  context.strokeRect(mark.x, mark.y, mark.w, mark.h);
}

// The close-up itself, with its caption.
function drawInset(context, ratio, inset) {
  const { frame, content } = inset;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = '#fcfcfb';
  context.fillRect(frame.x, frame.y, frame.w, frame.h);
  context.save();
  context.beginPath();
  context.rect(content.x, content.y, content.w, content.h);
  context.clip();
  drawView(context, ratio, inset.view);
  context.restore();
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.strokeStyle = CUE;
  context.lineWidth = 2;
  context.strokeRect(frame.x, frame.y, frame.w, frame.h);
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(frame.x, content.y + content.h);
  context.lineTo(frame.x + frame.w, content.y + content.h);
  context.stroke();

  // Caption: which area, how big, and how much of it has recovered in the August shown.
  let scarred = 0;
  let recovered = 0;
  for (const i of inset.burnArea.members) {
    const code = codeAt(i);
    if (code === 's') scarred += cells.area[i];
    if (code === 'r') recovered += cells.area[i];
  }
  // Captions shrink to fit the close-up's width: shorter wording first, then a smaller font,
  // and every line is capped at the box's width so no text spills out.
  const left = frame.x + 7;
  const room = frame.w - 14;
  const size = Math.max(11, Math.min(15, frame.w / 13));
  const font = (weight, px) => `${weight} ${px}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  const acresText = `${formatAcres(inset.burnArea.acres)} acres`;
  context.textBaseline = 'alphabetic';
  context.font = font(700, size);
  let name = `${inset.rank === 0 ? 'Biggest burn area' : 'Second biggest'} · ${acresText}`;
  if (context.measureText(name).width > room) name = `${inset.rank === 0 ? 'Biggest' : '2nd biggest'} · ${acresText}`;
  const line1 = content.y + content.h + size + 3;
  const line2 = line1 + size + 2;
  context.fillStyle = '#0b0b0b';
  context.fillText(name, left, line1, room);
  const share = scarred + recovered ? formatPercent(recovered / (scarred + recovered)) : '–';
  context.fillStyle = '#3a7d1f';
  context.fillText(`${share} recovered`, left, line2, room);
  const shareWidth = context.measureText(`${share} recovered`).width;
  // The click hint goes after the share only where it fits at full size.
  context.fillStyle = CUE;
  context.font = font(600, size - 1);
  const hint = '· click to zoom in';
  if (shareWidth + 5 + context.measureText(hint).width <= room) {
    context.fillText(hint, left + shareWidth + 5, line2);
  }
}

const inBox = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
const insetAt = (x, y) => insets.find((inset) => inBox(inset.frame, x, y) || inBox(inset.mark, x, y));

// Clicking a close-up (or the box it magnifies) zooms the map onto that burn area.
function mapClick(event) {
  const [mx, my] = d3.pointer(event);
  const inset = insetAt(mx, my);
  if (!inset) return;
  showInsets = false;
  mapTooltip.property('hidden', true);
  canvas.style('cursor', null);
  const box = areaBox(inset.burnArea, base.width / base.height);
  canvas.transition().duration(750).call(zoom.transform, fitBox(box));
}

function mapHover(event) {
  if (!cells) return;
  const [mx, my] = d3.pointer(event);
  const inset = insetAt(mx, my);
  canvas.style('cursor', inset ? 'pointer' : null);
  // Inside a close-up, read the cell under the pointer through the close-up's own view.
  let view = mainView();
  if (inset) {
    if (!inBox(inset.content, mx, my)) {
      mapTooltip.property('hidden', true);
      return;
    }
    view = inset.view;
  }
  const col = Math.floor((mx - view.tx) / view.sx);
  const r = Math.floor((my - view.ty) / view.sy);
  const i = cells.index.get(r * grid.cols + col);
  if (i === undefined) {
    mapTooltip.property('hidden', true);
    return;
  }
  const code = codeAt(i);
  const label = code === null ? MAP_PENDING.label : MAP_STATUS[code]?.label ?? 'No data';
  const part = { s: 'scarred', r: 'recovered', b: 'reburned' }[code];
  const lat = grid.north - (r + 0.5) * grid.res;
  const lon = grid.west + (col + 0.5) * grid.res;
  mapTooltip.property('hidden', false).html(
    `<strong style="color:${part ? TEXT_COLORS[part] : 'var(--ink-2)'}">${label}</strong>`
    + row('August', year)
    + row('Burned', zoomed)
    + row('Location', `${lat.toFixed(2)}°N, ${Math.abs(lon).toFixed(2)}°W`));
  const width = mapBox.node().clientWidth;
  const tipWidth = mapTooltip.node().offsetWidth;
  mapTooltip
    .style('left', `${mx + 14 + tipWidth > width ? mx - 14 - tipWidth : mx + 14}px`)
    .style('top', `${Math.max(4, my - 10)}px`);
}
