// Extras for the broadcast-themed copy of the page: the clock, the headline crawl, the
// "currently" sidebar (which follows the chart's slider and zoom), and the Watch live button.
// It reads the chart's state from main.js (year, zoomed, burnYears, statusAt, checked, cells),
// which shares the page's global scope, and refreshes on main.js's 'chartchange' event.

const pct = d3.format('.0%');
const shortAcres = (a) => (a >= 1e6 ? `${d3.format('.2~f')(a / 1e6)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}K` : `${Math.round(a)}`);

// ---------- Clock ----------
function tickClock() {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles',
  }).format(new Date());
  document.getElementById('station-clock').textContent = `${time} PT`;
}
tickClock();
setInterval(tickClock, 15000);

// ---------- Watch live = start the recovery playback ----------
document.getElementById('watch-live').addEventListener('click', () => {
  const play = document.querySelector('.play');
  if (play.textContent.includes('Watch')) play.click();  // only start, never pause
  document.querySelector('.monitor').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------- Sidebar readouts ----------
const DIAL_LENGTH = 2 * Math.PI * 50;
const dialFill = d3.select('#dial-fill').attr('stroke-dasharray', DIAL_LENGTH);

function refreshConditions() {
  if (typeof year === 'undefined' || year === null || !status) return;
  let scarred = 0;
  let recovered = 0;
  let reburned = 0;
  const years = zoomed === null ? burnYears.filter(checked) : [zoomed];
  for (const b of years) {
    const s = statusAt(b, year);
    scarred += s.scarred;
    recovered += s.recovered;
    reburned += s.reburned;
  }
  const counted = scarred + recovered;
  const share = counted ? recovered / counted : 0;
  d3.select('#cond-title').text(zoomed === null ? 'California' : `Burned in ${zoomed}`);
  d3.select('#cond-when').text(`As of August ${year}`);
  d3.select('#cond-recovered').text(counted ? pct(share) : '–');
  d3.select('#cond-scarred').text(counted ? pct(1 - share) : '–');
  d3.select('#cond-reburned').text(`${shortAcres(reburned)} ac`);
  d3.select('#dial-value').text(counted ? pct(share) : '–');
  dialFill.attr('stroke-dashoffset', DIAL_LENGTH * (1 - share));
  drawRadarAreas();
}
document.addEventListener('chartchange', refreshConditions);

// ---------- Mini "satellite" map ----------
// California's outline, plus boxes on the zoomed fire year's biggest burn areas.
const radar = d3.select('#radar-map');
let radarProject = null;
d3.json('data/california.json?v=3').then((rings) => {
  const points = rings.flat();
  const [lon0, lon1] = d3.extent(points, (p) => p[0]);
  const [lat0, lat1] = d3.extent(points, (p) => p[1]);
  const squash = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  const scale = Math.min(150 / ((lon1 - lon0) * squash), 160 / (lat1 - lat0));
  radarProject = ([lon, lat]) => [5 + (lon - lon0) * squash * scale, 5 + (lat1 - lat) * scale];
  const line = d3.line().x((p) => radarProject(p)[0]).y((p) => radarProject(p)[1]);
  radar.selectAll('path.ca').data(rings).join('path').attr('class', 'ca').attr('d', (ring) => `${line(ring)}Z`);
  radar.append('g').attr('class', 'radar-areas');
  radar.append('line').attr('class', 'radar-sweep').attr('x1', 80).attr('y1', 85).attr('x2', 80).attr('y2', 5);
  drawRadarAreas();
});

function drawRadarAreas() {
  if (!radarProject || typeof grid === 'undefined' || !grid) return;
  const areas = zoomed !== null && cells && cells.areas ? cells.areas : [];
  const toLonLat = (r, c) => [grid.west + c * grid.res, grid.north - r * grid.res];
  radar.select('.radar-areas').selectAll('rect')
    .data(areas)
    .join('rect')
    .each(function (a) {
      const [x0, y0] = radarProject(toLonLat(a.r0 - 3, a.c0 - 3));
      const [x1, y1] = radarProject(toLonLat(a.r1 + 3, a.c1 + 3));
      d3.select(this).attr('x', x0).attr('y', y0).attr('width', Math.max(4, x1 - x0)).attr('height', Math.max(4, y1 - y0));
    });
}

// ---------- Headline crawl ----------
// Every number is worked out from data/scarred_area.csv, so it matches the chart.
d3.csv('data/scarred_area.csv?v=3', d3.autoType).then((rows) => {
  const acres = (a) => (a >= 1e6 ? `${d3.format('.1f')(a / 1e6)} million` : d3.format(',')(Math.round(a / 1000) * 1000));
  const latest = d3.max(rows, (d) => d.august);
  const now = rows.filter((d) => d.august === latest);
  const recoveredShare = (list) => {
    const scarred = d3.sum(list, (d) => d.scarred_acres);
    const counted = d3.sum(list, (d) => d.burned_acres);
    return counted ? 1 - scarred / counted : 0;
  };
  const firstCheck = rows.filter((d) => d.august === d.burn_year + 1);
  const biggest = firstCheck.reduce((a, b) => (b.burned_acres + b.reburned_acres > a.burned_acres + a.reburned_acres ? b : a));
  const biggestNow = now.find((d) => d.burn_year === biggest.burn_year);
  const byAge = d3.rollups(rows, (list) => d3.sum(list, (d) => d.scarred_acres) / d3.sum(list, (d) => d.burned_acres),
    (d) => d.august - d.burn_year).sort((a, b) => a[0] - b[0]);
  const halfway = byAge.find(([age, share]) => age > 1 && share < 0.5);
  const early = now.filter((d) => d.burn_year <= 2005);
  const newest = now.filter((d) => d.burn_year === latest - 1);

  const items = [
    'California fire recovery outlook · satellite data 2001–2026',
    `As of August ${latest}, ${pct(recoveredShare(now))} of land burned in California since 2001 has grown back`,
    `${biggest.burn_year} was the biggest fire year: ${acres(biggest.burned_acres + biggest.reburned_acres)} acres burned, ${pct(recoveredShare([biggestNow]))} recovered so far`,
    halfway ? `On average, burned land is less than half scarred about ${halfway[0]} years after a fire` : null,
    `Fires from 2001–2005: ${pct(recoveredShare(early))} of the land has recovered`,
    newest.length ? `Fires of ${latest - 1}: ${pct(recoveredShare(newest))} recovered at the first check, one year later` : null,
    'Source: NASA MODIS burned area and satellite greenness, checked every August',
  ].filter(Boolean);
  const html = items.map((text) => `<span class="ticker-item">${text}</span>`).join('');
  document.getElementById('ticker-track').innerHTML = html + html;  // twice, so the loop has no gap
});
