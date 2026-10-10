# Data sources

Every source, grouped by tier, with its key requirement, licence note and what it feeds.

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

## Data Sources (71)

71 source adapters run in every sweep: 31 established feeds in tiers 1–6, the 36 "current public data" feeds of tier 7 and 4 country inputs in tier 8. Static datasets that ship with the program (pipelines, bases, mapped sites) are listed after the tiers.

### Tier 1: Core OSINT & Geopolitical (11)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **GDELT** | Conflict, economy, health and crisis stories from the 15-minute GKG news feed (100+ languages), ranked by theme focus (distinct themes count more than one repeated theme), with city-level map points | None |
| **OpenSky** | ADS-B observations across 10 hotspots; fallback expires after one hour | None |
| **NASA FIRMS** | Satellite fire/thermal anomaly detection (3hr latency) | Free key |
| **Maritime** | Reference chokepoints; the briefing adapter does not connect to live AIS | None for reference data |
| **Safecast** | Citizen-science radiation readings near 6 nuclear sites; two sites are refreshed per sweep and the rest come from a cache of at most 3 hours with its age shown | None |
| **ACLED** | Armed conflict events: battles, explosions, protests | Free (OAuth2) |
| **ReliefWeb** | UN humanitarian crisis tracking | None |
| **WHO** | Disease outbreaks and health emergencies | None |
| **OFAC** | US Treasury sanctions (SDN list) | None |
| **OpenSanctions** | Aggregated global sanctions (30+ sources) | Partial |
| **ADS-B Exchange** | Unfiltered flight tracking including military | Paid |

### Tier 2: Economic & Financial (7)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **FRED** | 22 key indicators: yield curve, CPI, VIX, fed funds, M2 | Free key |
| **US Treasury** | National debt, yields, fiscal data | None |
| **BLS** | CPI, unemployment, nonfarm payrolls, PPI | None |
| **EIA** | WTI/Brent crude, natural gas, inventories | Free key |
| **GSCPI** | NY Fed Global Supply Chain Pressure Index | None |
| **USAspending** | Federal spending and defense contracts | None |
| **UN Comtrade** | Strategic commodity trade flows between major powers | None |

### Tier 3: Weather, Environment, Tech, Social, SIGINT (8)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **NOAA/NWS** | Active US weather alerts | None |
| **EPA RadNet** | US government radiation monitoring | None |
| **USPTO Patents** | Patent filings in 7 strategic tech areas | None |
| **Bluesky** | Social sentiment on geopolitical/market topics | None |
| **Reddit** | Social sentiment from key subreddits | OAuth |
| **Telegram** | Public channel previews, opt-in; never private bot updates | Explicit opt-in |
| **KiwiSDR** | Global HF radio receiver network (~600 receivers) | None |
| **USGS** | Significant earthquakes in the past day | None |

### Tier 4: Space & Satellites (1)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **CelesTrak** | Satellite launches, ISS tracking, military constellations, Starlink/OneWeb counts | None |

### Tier 5: Live Market Data (1)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **Yahoo Finance** | Real-time prices: SPY, QQQ, BTC, Gold, WTI, VIX + 9 more | None |

### Tier 6: Cyber & Infrastructure (3)

| Source | What It Tracks | Auth |
|--------|---------------|------|
| **CISA KEV** | Known exploited vulnerability catalog | None |
| **Cloudflare Radar** | Internet outages and traffic anomalies | API token |
| **IODA** | Internet connectivity anomaly signals | None |

---

### Tier 7: Current public data (29)

All 29 feeds are free and require no API key. The **Current public data** panel shows provider time, status, attribution and a summary of the current records, which open in the [Record Inspector](FEATURES.md#record-inspector-v29). Records have original links and enter event details, searchable history and exports. Located records are map markers in the layer of their kind (earthquakes, maritime, air, natural events, weather, GNSS interference, orbital launches) and colour; a quake that USGS and EMSC both report (within 60 s and 100 km) is drawn once, as the USGS marker, while both events stay in the lists. Provider dates are checked again on snapshot reads and in the browser, including offline PWA restores; expired values are hidden.

| Source | Data / default watched scope | Freshness ceiling |
| --- | --- | --- |
| Meteoalarm Atom | Active warnings: Hungary, Austria, Germany | Feed 3h; issued warning 48h and not expired |
| GDACS | Current disaster updates worldwide; future onsets excluded | Feed 6h; event update 72h |
| NOAA SWPC | Current R/S/G scales; zero means no active alert | 1h |
| ECB | Daily EUR/HUF, USD, GBP, CHF reference rates | 5 days for weekends/holidays; date precision |
| NASA EONET | Open natural events, latest Point geometry worldwide | 72h |
| RIPEstat | AS5483 routing visibility; 00/08/16 UTC snapshots | 12h (8h cadence + publication lag); 30 min cache |
| FIRST EPSS | Daily estimates for 20 CVEs first scored in the last 7 days | 48h; predictions, not confirmed exploitation |
| MET Norway | Budapest model forecast, separate target/validity times | Model 8h; target within 1h of now and valid interval |
| OONI | Five recent public HU web-connectivity measurements | 24h; samples, not country-wide conclusions |

Added since v2.11 (twenty-seven more keyless feeds: ten in v2.11, then ThreatFox, HIBP, GPSJam, WMO SWIC, UNHCR arrivals, SEC 8-K, in v2.27–v2.29 ADSB Orbits, Open-Meteo wind, NOAA NHC and Launch Library 2, in v2.32 JMA Typhoon and ECDC Threats, in v2.33 Central banks and CFTC COT, in v2.34 FAA Airports and Regulators, and in v2.36 Eurostat HU; every request is bounded to 10 s and 2 MiB, 3 MiB for the OpenSanctions index):

| Source | Data / default watched scope | Endpoint | Auth | Freshness ceiling | Licence |
| --- | --- | --- | --- | --- | --- |
| IMF PortWatch | AIS-visible daily ship transits at 8 chokepoints (latest published day, 2–9 days behind), rated on the 7-day mean against the previous 28-day median (only from 10 transits a day) | `services9.arcgis.com/…/Daily_Chokepoints_Data` (ArcGIS) | None | Feed and day 10 days; 6h cache | IMF terms: personal, non-commercial use |
| EMSC | M4.5+ earthquakes of the last 24 h, largest first, up to 100 | `seismicportal.eu/fdsnws/event/1/query` | None | Feed 12h; quake 26h | CC BY 4.0 |
| Copernicus EMS | Rapid-mapping activations (no severity is published: moderate) | `mapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/` | None | Feed 45 days; activation 30 days; 1h cache | Free, full and open (Regulation (EU) 2021/696) |
| Aviation SIGMET | International SIGMETs worldwide (volcanic ash, tropical cyclone, severe turbulence and icing, thunderstorms) that have started and not expired | `aviationweather.gov/api/data/isigmet` | None | Feed 3h; SIGMET 24h and valid-until | Public domain (NWS) |
| ADSB-Military (adsb.lol) | Military aircraft per watched theater (an aggregate at the box centre, not positions) and 7700/7600/7500 emergency squawks | `api.adsb.lol/v2/mil`, `/v2/sqk/<code>` | None | 25 min | ODbL 1.0 |
| OpenSanctions index | Last change and entry count of six sanctions lists (OFAC SDN, EU FSF, UN SC, UK FCDO, BIS Denied, US CSL) | `data.opensanctions.org/datasets/latest/index.json` | None | Index 48h; list change 14 days; 1h cache | CC BY-NC 4.0 |
| Federal Register | Newest OFAC and BIS documents | `federalregister.gov/api/v1/documents.json` | None | 14 days; 1h cache | Public domain |
| Energy-Charts HU | Hungarian day-ahead power price, Continental Europe grid frequency, Hungarian renewable share of generation | `api.energy-charts.info` (`/price`, `/frequency`, `/public_power`) | None | 6h; 2 min cache | CC BY 4.0 (price: Bundesnetzagentur \| SMARD.de) |
| ENTSOG HU | Physical gas flow at the 7 Hungarian cross-border points, latest completed gas day | `transparency.entsog.eu/api/v1/operationaldata` | None | 72h; 1 request an hour while it answers (a failure is retried at the next sweep) | ENTSOG Transparency Platform terms (re-use with citation) |
| Prediction markets (Manifold) | Play-money markets whose question matches the watched words, most traded first, up to 20 | `api.manifold.markets/v0/search-markets` | None | Last bet 12h, market not closed; 30 min cache | Manifold terms: personal, non-commercial use |
| ThreatFox (abuse.ch) | New indicators of compromise of the last 24 h per malware family, top 10; moderate from 100 | `threatfox.abuse.ch/export/json/recent/` | None | Feed 6h; row 24h; 10 min cache | CC0 |
| Have I Been Pwned | Breaches added in the last 30 days (not sensitive, fabricated, spam or retired); moderate from 1 million accounts, high from 10 million | `haveibeenpwned.com/api/v3/breaches` | None | Feed 14 days; row 30 days; 1h cache | CC BY 4.0 |
| GPSJam | GNSS interference seen by aircraft: one row per region and the 15 worst H3 hexagons of the latest day (at least 3 aircraft; more than 10% bad is high); rated moderate at most | `gpsjam.org/data` (`manifest.csv`, `<day>-h3_4.csv`) | None | Day end + 96 h; 3 h cache | Provider terms (cite gpsjam.org, ADS-B Exchange data) |
| WMO SWIC | Severe and extreme official warnings of WMO members outside Europe and the USA, one row per member and event (25 at most), at the member's point | `severeweather.wmo.int/json` (`wmo_all.json`, `wmo_member.json`) | None | 3 h; rows end at expiry | Provider terms (cite WMO SWIC and the issuing service) |
| UNHCR arrivals | Sea and land arrivals in Europe per receiving country (Greece, Spain, Italy, Cyprus, Malta): since 1 January, the last complete month and the usual month; moderate when the last month is at least 1,000 and twice the usual | `data.unhcr.org/population/get/sublocation` (sv_id 100) | None | Newest report within 21 days; 6 h cache | CC BY 4.0 (UNHCR) |
| SEC EDGAR 8-K Item 1.05 | Form 8-K filings of the last 90 days that report a material cybersecurity incident (company, form, filing day, link; every row high) | `efts.sec.gov/LATEST/search-index` (two phrases, spaced a second apart) | None (optional `SEC_USER_AGENT`) | Feed 90 days; row 90 days; 1h cache | Public domain |
| ADSB Orbits (adsb.lol) | Military aircraft flying orbits (circles, racetracks) in the last two hours, one aggregate row per theater: count, types, countries of registry (adsbdb); no callsigns | `api.adsb.lol/v2/mil` (shared with ADSB-Military) and `adsb.lol/data/traces/` (at most 12 aircraft a sweep) | None | 25 min | ODbL 1.0 |
| Open-Meteo wind | Modelled current 10 m wind (speed, from, toward, gusts) at the six watched nuclear sites; not a dispersion forecast | `api.open-meteo.com/v1/forecast` (one request for six points) | None (non-commercial use; a commercial deployment needs a key) | 3 h; 10 min cache | CC BY 4.0 |
| NOAA NHC / CPHC | Active tropical cyclones of the Atlantic and the eastern and central North Pacific: one row per storm (class, sustained wind, pressure, movement; rated by wind from low to critical) and the advisory forecast track, points and cone for the map layer | `nhc.noaa.gov/CurrentStorms.json` and the NHC tropical-weather-summary MapServer (layers 5, 6, 7; server-generalised geometry) | None | Advisory 8 h; row 12 h; 5 min cache | U.S. public domain (NOAA/NWS) |
| Launch Library 2 | Orbital launches in the next 14 days and the last 7 days, at their pad; government and military payloads rated moderate, failures elevated | `ll.thespacedevs.com/2.3.0/launches/{upcoming,previous}` | None (15 calls an hour anonymously; 2 per sweep, 15 min cache, the last good answer for an hour when throttled) | Entry updated within 12 h | The Space Devs terms (use and share; attribution encouraged) |
| JMA Typhoon | Active tropical cyclones of the western North Pacific from the Japan Meteorological Agency: one row per system (class, sustained wind, pressure, speed; rated by wind) and the forecast positions up to five days ahead as a track for the map layer; no cone (the JMA publishes probability circles) | `jma.go.jp/bosai/typhoon/data/targetTc.json` and `.../<TCxxxx>/specifications.json` | None | Advisory 8 h; row 12 h; 5 min cache | Government of Japan Standard Terms of Use (CC BY 4.0 compatible) |
| ECDC Threats | The newest outbreak news and epidemiological updates of the European Centre for Disease Prevention and Control; the ALERT / WARNING / WATCH level is read from the headline words only, it is not an ECDC risk assessment | `ecdc.europa.eu/en/taxonomy/term/1307/feed` and `.../1310/feed` (RSS) | None | Feed 14 d; item 21 d; 1 h cache | ECDC copyright notice (reuse with attribution) |
| Central banks | Policy rates of 14 central banks (BIS, Hungary first), their change over about a quarter, the ECB euro short-term rate (€STR) and the ECB composite indicator of systemic stress (CISS; moderate from 0.3, high from 0.6, Crucix's own reading) | `stats.bis.org/api/v1/data/WS_CBPOL` and `data-api.ecb.europa.eu` (EST, CISS), SDMX JSON | None | Feed 14 d; policy rate row 120 d (the BIS date is the last reported day); €STR and CISS 10 d; 1 h cache | BIS terms of use and ECB reuse policy (attribution) |
| CFTC COT | Net position of speculators (managed money in gold, silver, WTI; leveraged funds in the euro, S&P 500 E-mini, 10-year note), its share of open interest, the week change and its rank among the last year; the extremes (top or bottom 5%) are rated moderate | `publicreporting.cftc.gov/resource/rxbv-e226.json` and `yw9f-hn96.json` (Socrata) | None | Report 12 d (weekly, as of Tuesday); 6 h cache | U.S. government public data (CFTC) |
| FAA Airports | Ground stops, ground delay programs and arrival/departure delays announced by the FAA at busy airports (rated by the average delay: 30 min moderate, 60 elevated, 90 high; a ground stop is high), at the airport's reference position. The "Airport Closures" list is not used: it holds NOTAM restrictions, not closures | `nasstatus.faa.gov/api/airport-status-information` (XML) | None | Update time 3 h; 5 min cache | U.S. government public data (FAA) |
| Regulators | Headlines and links of the newest Federal Reserve press releases (FOMC and monetary-policy headlines rated moderate), SEC press releases and FINRA notices; the CFTC and FDIC feeds are not used | `federalreserve.gov/feeds/press_all.xml`, `sec.gov/news/pressreleases.rss`, `feeds.finra.org/FINRANotices` | None | Feed 7 d; item 14 d; 30 min cache | U.S. government public information; FINRA public notices (headline and link only) |
| Eurostat HU | Hungary's inflation (HICP annual rate), unemployment rate (seasonally adjusted) and real GDP growth (quarter on quarter), each with the EU27 figure for the same period; provisional values marked; inflation from 5%, unemployment from 8% and a GDP contraction are rated moderate (Crucix's own reading) | `ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{prc_hicp_minr,une_rt_m,namq_10_gdp}` (JSON-stat) | None | Feed 90 d; value 180 d (monthly and quarterly data); 6 h cache | Eurostat reuse policy (CC BY 4.0 compatible) |

Alert rules can watch the metrics `<chokepoint>_transits` (PortWatch 7-day mean, transits a day; `hormuz_transits`, `suez_transits` and the other six default chokepoints), `hu_power_price` (EUR/MWh), `grid_frequency_hz` and `mil_aircraft_total` (military aircraft worldwide, airborne, position within 2 minutes); a metric is empty while its source is stale or failing. The HU day-ahead price runs high (median about 194 EUR/MWh over 2026-09-19..10-02; price rows are rated only from 300 and 400 EUR/MWh), so give a `hu_power_price` threshold rule its own level.

Edit the small `publicSources` watchlists in `crucix.config.mjs` for Meteoalarm countries, RIPE ASNs, MET location labels/coordinates, OONI countries, PortWatch chokepoints (`portwatchChokepoints`), ADS-B theater boxes (`adsbTheaters`) and prediction-market words (`marketQueries`). Each adapter validates and limits its inputs. MET identifies Crucix with a project/contact User-Agent; public requests and memory caches are bounded. Empty current feeds remain distinct from failed or undated feeds. World Bank annual indicators are deliberately excluded because this installation requires current data.

Full endpoint, freshness and validation evidence: [source assessment](audit/fresh-data-implementation-2026-10-01.md).

### Tier 8: Country risk and context inputs (4)

All four are free and key-less, every request is bounded to 10 s and 2 MiB, and the country-risk model reads the first three (a missing source only lowers the coverage of a score). They are plain sources: a source-health row, no live-data card, listed under the security and conflict lens.

| Source | What it tracks | Endpoint | Cache | Attribution and licence |
| --- | --- | --- | --- | --- |
| VIEWS-Forecast | Predicted probability of at least 25 battle-related deaths in state-based armed conflict, and predicted fatalities, per country for the three months after the newest run's data month; a forecast, not observed events | `api.viewsforecasting.org` (run list, then `/<run>/cm/sb`) | Run list 24 h; data per run id; last good payload 45 days, shown as stale | "VIEWS (Uppsala University and PRIO)" and the run id; the provider states no data licence (its code repositories are CC BY-NC) |
| INFORM-Risk | INFORM Risk Index, 0-10 per country (higher is worse), newest published release; a yearly baseline | `drmkc.jrc.ec.europa.eu/inform-index/API/InformAPI` (release list, then scores) | Release list 24 h; scores 7 days; last good result 45 days, shown as stale | "INFORM Risk Index, European Commission Joint Research Centre (DRMKC) / INFORM partnership, <release>"; the provider says only "INFORM is open-source" |
| Travel-Advisories | U.S. State Department travel advisory level (1-4) per country, 212 countries; the seventh component of the risk model (v2.19) | `travel.state.gov/_res/rss/TAsTWs.xml` | 6 h | U.S. government public information |
| MISP-Galaxy | Known threat actor groups attributed to each country by the MISP community, with aliases; context on the country sheet only, never part of the score (v2.16) | `raw.githubusercontent.com/MISP/misp-galaxy/main/clusters/threat-actor.json` | 7 days; last good result 45 days, shown as stale | CC0 1.0 (MISP Project, CIRCL and the community) |

### Static datasets and the basemap

These ship with the program or are cached by the server; none of them is queried in the sweep.

| Data | What it is | Licence and credit |
| --- | --- | --- |
| Pipelines and bases (`data/infrastructure.json`, 200 KB) | 618 oil and gas pipelines (end points only; the line is a great circle, not the route) with physical state, and 226 military bases, compiled by World Monitor | Pipelines: operator disclosures, regulators, ENTSOG, Global Energy Monitor (CC BY 4.0); a base listed is no statement about its garrison |
| Mapped sites (`data/sites.json`, 770 KB) | 6,634 named military areas, 3,681 data centres, 581 dams, rebuilt with `scripts/build-sites.mjs` | © OpenStreetMap contributors and Overture Maps Foundation, ODbL 1.0, via God's Eye View; incomplete by nature |
| Daily satellite image (`/api/basemap/daily.jpg`) | NASA GIBS VIIRS (NOAA-20) true-colour whole-Earth composite of yesterday, 4096×2048, cached by the server for the day | NASA GIBS, public domain; acknowledgement shown in the © panel |
| Globe textures and country outlines | Night-lights texture, Natural Earth outlines via world-atlas, fonts, libraries (pinned local assets) | See `dashboard/public/vendor/licenses` |

The **©** button on the map shows the credits and licences of whatever is on screen.
