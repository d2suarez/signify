// ===================================================================
// Teacher's Desk — weather, via Open-Meteo
//
// Proxied through this server rather than called from the browser, for the
// same reason the fonts are self-hosted: a widget on thirty classroom
// machines calling a third party directly would report every teacher's IP
// address to somebody who is not on the subprocessor list. Open-Meteo sees
// this server, and nothing else.
//
// Two other things follow from that:
//   * Coordinates are rounded to 2dp (about a kilometre) before they leave.
//     That is ample for "will it rain at break" and does not pin a school.
//   * Answers are cached, so a staffroom full of desks is a handful of
//     requests an hour rather than one per teacher per refresh.
//
// No API key: Open-Meteo's free tier needs none, which is why it was chosen
// over the alternatives.
// ===================================================================

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
// Open-Meteo's name search knows some postcodes and not others — 90210 finds
// Beverly Hills, 23173 finds nothing at all — so a real postcode lookup backs
// it up. Keyless, like everything else here.
const POSTAL = 'https://api.zippopotam.us';

// Postcodes worth trying, and where. Only formats that are unambiguous enough
// to be worth a second request.
const POSTCODES = [
  { re: /^\d{5}$/, country: 'us' },
  { re: /^\d{5}-\d{4}$/, country: 'us', clean: (q) => q.slice(0, 5) },
  { re: /^[a-z]\d[a-z]\s?\d[a-z]\d$/i, country: 'ca', clean: (q) => q.replace(/\s/g, '').slice(0, 3) },
];

/** A place from a postcode, or null if it is not one / is not known. */
async function byPostcode(query) {
  const q = String(query || '').trim();
  const match = POSTCODES.find((p) => p.re.test(q));
  if (!match) return null;
  const code = (match.clean ? match.clean(q) : q).toUpperCase();

  try {
    const res = await fetch(`${POSTAL}/${match.country}/${encodeURIComponent(code)}`, {
      headers: { 'user-agent': "Teacher's Desk (desk.signify.one)" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const place = (body.places || [])[0];
    if (!place) return null;
    return {
      name: `${place['place name']}${place['state abbreviation'] ? `, ${place['state abbreviation']}` : ''}`,
      detail: `${code} · ${body.country || ''}`.trim(),
      lat: Math.round(Number(place.latitude) * 100) / 100,
      lon: Math.round(Number(place.longitude) * 100) / 100,
      zone: '',
    };
  } catch { return null; }
}

const CACHE_MS = 10 * 60 * 1000;
const GEO_CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

function cached(key, ttl, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
  return produce().then((value) => {
    if (value != null) {
      cache.set(key, { at: Date.now(), value });
      // The map is per-process and tiny, but it should not grow for ever.
      if (cache.size > 500) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
    }
    return value;
  });
}

async function ask(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': "Teacher's Desk (desk.signify.one)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`weather service answered ${res.status}`);
  return res.json();
}

/** Places matching what the teacher typed. */
async function search(query) {
  const q = String(query || '').trim().slice(0, 80);
  if (q.length < 2) return [];

  return cached(`geo:${q.toLowerCase()}`, GEO_CACHE_MS, async () => {
    // A postcode is an exact answer, so it goes first and on its own — a
    // teacher who typed one does not want eight guesses at a town name.
    const postal = await byPostcode(q);
    if (postal) return [postal];

    const url = `${GEOCODE}?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
    const body = await ask(url);
    return (body.results || []).map((r) => ({
      name: r.name,
      // Enough to tell two Springfields apart, and no more.
      detail: [r.admin1, r.country].filter(Boolean).join(', '),
      lat: Math.round(r.latitude * 100) / 100,
      lon: Math.round(r.longitude * 100) / 100,
      zone: r.timezone || '',
    }));
  });
}

/**
 * Now, and hour by hour for the next two days.
 * Coordinates are rounded before they are used as a cache key AND before they
 * are sent, so the rounding is what actually leaves this building.
 */
async function forecast(lat, lon, units) {
  const la = Math.round(Number(lat) * 100) / 100;
  const lo = Math.round(Number(lon) * 100) / 100;
  if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('That is not a place.');
  if (la < -90 || la > 90 || lo < -180 || lo > 180) throw new Error('That is not a place.');
  const imperial = units === 'imperial';

  return cached(`fc:${la},${lo},${imperial ? 'F' : 'C'}`, CACHE_MS, async () => {
    const params = new URLSearchParams({
      latitude: String(la),
      longitude: String(lo),
      ...(imperial ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph' } : {}),
      current: 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day',
      hourly: 'temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m',
      daily: 'sunrise,sunset,temperature_2m_max,temperature_2m_min',
      forecast_days: '2',
      timezone: 'auto',
    });
    const body = await ask(`${FORECAST}?${params}`);

    return {
      fetchedAt: Date.now(),
      timezone: body.timezone,
      units: {
        temperature: body.current_units && body.current_units.temperature_2m,
        wind: body.current_units && body.current_units.wind_speed_10m,
      },
      current: body.current || null,
      // Trimmed to what the widget draws, so the response the browser gets is
      // small and contains nothing it has no use for.
      hourly: (body.hourly && body.hourly.time || []).map((t, i) => ({
        t,
        temp: body.hourly.temperature_2m[i],
        feels: body.hourly.apparent_temperature[i],
        rain: body.hourly.precipitation_probability[i],
        code: body.hourly.weather_code[i],
        wind: body.hourly.wind_speed_10m[i],
      })),
      daily: body.daily || null,
    };
  });
}

module.exports = { search, forecast };
