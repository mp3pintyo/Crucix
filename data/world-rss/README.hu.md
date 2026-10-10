# Világméretű RSS-katalógus – 2026. október 10.

## Eredmény és határok

1579 jelöltet vizsgáltunk; 1168 cím adott cikkeket tartalmazó RSS/Atom XML-t. A javasolt angol-első konfiguráció 539 feedet tartalmaz. A további helyi nyelvű alternatívák száma 430.

Az országlista 193 ENSZ-tagot és két megfigyelő államot (Vatikán/Szentszék, Palesztina) kezel alapként; Tajvan, Koszovó és a függő területek külön sorokat kapnak. Összesen 250 ország/terület szerepel.

A 195 alapország státuszai: {'english_native': 132, 'local_native': 53, 'gap': 9, 'external_only': 1}. Ez nem jelenti, hogy minden országban sikerült saját, angol nyelvű kiadói RSS-t igazolni. A hiányok külön szerepelnek; külföldi országtudósítást nem számolunk helyi médiumnak. A kiadó országa szerinti besorolás a forrásjegyzékből és kézi megjegyzésekből származik, nem teljes körű szerkesztőségi audit.

## Fájlok

| Fájl | Felhasználás |
| --- | --- |
| `world-feeds.js` | Beilleszthető `feed(...)` hívások; `createWorldFeeds(feed)` adja vissza a tömböt. |
| `complete-world-feeds.js` | A kiadói lista plusz a hiányos országok keresőfeedjei; `createCompleteWorldFeeds(feed)`. |
| `country-fallback-feeds.js` | Csak a 10 helyi-feed-hiányos ország opcionális angol keresése. |
| `local-alternatives.js` | Helyi nyelvű kiegészítők az angollal is rendelkező országokhoz. |
| `country-search-feeds.js` | Opcionális angol Google News keresések mind a 195 alapországhoz; külső aggregátor. |
| `world-feeds.opml` | Importálás RSS-olvasóba, országonkénti mappákkal. |
| `registry.json` | Minden vizsgált cím, a kizárt jelöltekkel és a technikai ellenőrzés adataival együtt. |
| `country-coverage.csv` | Országonkénti lefedettség, hiányok és opcionális angol Google News keresés. |

## Beillesztés

```js
import { createWorldFeeds } from './world-feeds.js';
const feeds = createWorldFeeds(feed);
```

A teljes 195 országot célzó változathoz: `import { createCompleteWorldFeeds } from './complete-world-feeds.js'; const feeds = createCompleteWorldFeeds(feed);`. Ez 549 bejegyzést ad, ebből 10 Google News keresés. A keresés országról szóló híreket gyűjt, nem helyi médiumot helyettesít szerkesztőségileg.

Ha a jelenlegi konfigurációba másolod, a `return [...]` belsejében lévő hívásokat használd. A lista összevont konfiguráció: ne add hozzá változatlanul a teljes régi listához, mert duplikációk keletkeznek. A jelenlegi `feed` függvény a `country` mezőt esetleg eldobhatja; ország szerinti szűréshez a visszaadott objektumban is meg kell őrizni.

Az eredeti numerikus értékeket és `state: true` jelzéseket megőriztük. Az új feedek **3-as értéke ideiglenes alapérték**, mert a 1–4 skála jelentését nem adtad meg. Nem végeztünk hitelességi rangsorolást. Új `state` értéket nem találgattunk; a jelzés hiánya nem állítás a tulajdonosi viszonyokról. Állami, közszolgálati és magánkiadók is előfordulnak.

## Ellenőrzési módszer

GET kérés, HTTP eredmény, XML parse, RSS/Atom/RDF gyökérelem és legalább egy cikk. A kiválasztott feed legújabb dátuma legfeljebb 30 napos; ha nincs értelmezhető dátum, a frissesség `unknown`, és a feed technikailag engedélyezett. A jelentősen jövőbeli dátumokat kizártuk. Ez pillanatnyi, ebből a környezetből végzett elérési próba, nem tartós rendelkezésre állási garancia és nem böngészős CORS-teszt. Fizetőfalas cikkek feedje is működhet. Egy 403 vagy timeout nem bizonyítja, hogy az URL megszűnt.

A nyelvet legfeljebb négy cikkcím összefűzött mintájából becsültük, legalább 0,8 detektálási bizonyosságnál; különben a katalógus nyelvi metaadata maradt. Ez nem fordítás, és rövid/multinyelvű címeknél lehet téves. Az angol-első választás országonként legfeljebb öt angol feedet használ; ha ilyen nincs, legfeljebb négy helyi nyelvűt. A magyar eredeti források külön kivételként megmaradnak, ha megfeleltek az ellenőrzésnek.

Csak működő végpontokat választottunk, de a médium nagyságát, helyi befolyását és az ország-hozzárendeléseket nem igazoltuk mindegyiknél külön. A gyűjtemény bővíthető országos alap, nem a világ összes nagy médiumának teljes leltára. RSS-közvetítőket és egyszerű főoldalakat kizártunk. Egyes kiadói FeedBurner feedek emiatt kimaradhattak.

## Országonkénti kimutatás

`EN` = igazolt angol helyi feed; `LOCAL` = igazolt helyi nyelvű feed; `EXTERNAL` = csak külföldi országtudósítás; `GAP` = nem igazoltunk használható helyi feedet. A `GAP` nem bizonyítja, hogy nincs ilyen.

| ISO | Ország | Státusz | Kiválasztott helyi médiumok |
| --- | --- | --- | --- |
| AF | Afghanistan | EN | Khaama Press; Amu TV; Ariana News; Bakhtar News Agency |
| AL | Albania | EN | Tirana Times |
| DZ | Algeria | LOCAL | Le Matin d'Algérie; AL24 News; Algérie 360; El Khabar |
| AD | Andorra | LOCAL | Ara Andorra; Bondia; Diari d'Andorra; El Periòdic d'Andorra |
| AO | Angola | LOCAL | Folha 8; Rádio Nacional de Angola (RNA) |
| AG | Antigua & Barbuda | EN | ABS TV Radio Antigua & Barbuda; Antigua.news; Antiguan Herald |
| AR | Argentina | EN | Buenos Aires Times |
| AM | Armenia | EN | EVN Report; Mediamax |
| AU | Australia | EN | ABC Australia; SBS Australia; ABC Australia; 7NEWS; PerthNow |
| AT | Austria | EN | The Local Austria |
| AZ | Azerbaijan | EN | Trend News Agency |
| BS | Bahamas | EN | Bahamas Press; Bahamas Spectator; Eyewitness News; Our News; The Tribune |
| BH | Bahrain | EN | Biz Bahrain |
| BD | Bangladesh | LOCAL | Banglanews24.com; Prothom Alo |
| BB | Barbados | EN | Caribbean Broadcasting Corporation (CBC); Barbados Today; Nation News; The Barbados Advocate |
| BY | Belarus | LOCAL | Belapan; Belsat TV; Hazeta Slonimskaya; Neg.by |
| BE | Belgium | EN | EU Reporter; The Bulletin |
| BZ | Belize | EN | Amandala; Ambergris Today; Channel 5 Belize |
| BJ | Benin | LOCAL | 24 Heures au Bénin; Benin Site; Fraternité; L'économiste du Bénin |
| BT | Bhutan | EN | Bhutan Broadcasting Service; Business Bhutan; Daily Bhutan; Daily Bhutan Times; The Bhutanese |
| BO | Bolivia | LOCAL | ATB Digital; Agencia Boliviana de Información; El Deber; Opinión |
| BA | Bosnia | EN | Sarajevo Times |
| BW | Botswana | EN | Sunday Standard; The Botswana Gazette; The Voice; Weekend Post |
| BR | Brazil | LOCAL | CNN Brasil; Canaltech; Exame; GloboNews |
| BN | Brunei | EN | Biz Brunei; The Bruneian; The Scoop |
| BG | Bulgaria | EN | Novinite.com (Sofia News Agency) |
| BF | Burkina Faso | LOCAL | Burkina24; LeFaso.net; Le Pays |
| BI | Burundi | EN | Burundi Times |
| KH | Cambodia | EN | CamboJA News |
| CM | Cameroon | LOCAL | CameroonOnline.org; Journal du Cameroun; Le Jour |
| CA | Canada | EN | Global News |
| CV | Cape Verde | LOCAL | Notícias do Norte; A Nação; Expresso das Ilhas |
| CF | Central African Republic | LOCAL | Radio Ndeke Luka |
| TD | Chad | LOCAL | Journal du Tchad; Le Pays; Le Tchadanthropus-tribune; Office National des Médias Audiovisuels (ONAMA) |
| CL | Chile | LOCAL | La Prensa Austral; La Tercera; Ciperchile; La Discusión |
| CN | China | EN | CGTN |
| CO | Colombia | EN | The City Paper Bogotá; colombiareports. |
| KM | Comoros | LOCAL | Habari Za Comores; Habari Za Comores |
| CR | Costa Rica | EN | Q Costa Rica; The Costa Rica News |
| HR | Croatia | LOCAL | 24sata; Dubrovački vjesnik; Glas Slavonije; Index.hr |
| CU | Cuba | LOCAL | Bohemia; Escambray; Juventud Rebelde; Radio Rebelde |
| CY | Cyprus | EN | Cyprus Mail |
| CZ | Czechia | EN | Expats.cz; Prague Morning |
| CI | Côte d’Ivoire | LOCAL | Linfodrome; Radiodiffusion Télévision Ivoirienne (RTI) |
| CD | Democratic Republic of the Congo | LOCAL | Le Potentiel; RTNC |
| DK | Denmark | EN | The Local Denmark |
| DJ | Djibouti | LOCAL | Radiodiffusion Télévision de Djibouti (RTD); DjibNet; La Voix de Djibouti |
| DM | Dominica | EN | Dominica News |
| DO | Dominican Republic | LOCAL | AlMomento.net; Antena 7; Color Visión; Diario Libre |
| EC | Ecuador | LOCAL | El Comercio; Crónica; Diario Extra; El Diario |
| EG | Egypt | EN | Egypt Independent |
| SV | El Salvador | LOCAL | ContraPunto; Diario Co Latino; El Metropolitano Digital; El Salvador Times |
| GQ | Equatorial Guinea | LOCAL | AHORAEG Guinea Ecuatorial |
| ER | Eritrea | EN | Awate.com; Setit |
| EE | Estonia | EN | ERR News |
| SZ | Eswatini | EN | Eswatini Broadcasting and Information Services (EBIS) |
| ET | Ethiopia | EN | Addis Fortune; Ethiopia Insight; Ethiopia Observer |
| FJ | Fiji | EN | FBC News; Islands Business; Pacific Islands News Association (PINA) |
| FI | Finland | EN | Yleisradio (Yle) |
| FR | France | EN | Euronews; France 24; RFI; Le Monde English; Le Monde English International |
| GA | Gabon | LOCAL | Agence Gabonaise de Presse (AGP); Direct Infos Gabon; Gabon Actu; Gabonreview |
| GM | Gambia | EN | The Standard; Foroyaa; Kerr Fatou; The Point; What's On Gambia |
| GE | Georgia | EN | Civil.ge |
| DE | Germany | EN | DW; DW News; Der Spiegel English |
| GH | Ghana | EN | Accra Mail; EnewsGhana; Ghana Business News; Ghanaian Times; MyJoyOnline |
| GR | Greece | LOCAL | Capital.gr; ERT News; Eleftheros Typos; Ethnos |
| GD | Grenada | EN | NOW Grenada; WEE FM Radio Grenada |
| GT | Guatemala | LOCAL | Agencia Guatemalteca de Noticias; Chapin TV; Emisoras Unidas; Prensa Comunitaria |
| GN | Guinea | LOCAL | Guinee360.com; Guinee7.com; GuineeTime.com; Visionguinee.info |
| GW | Guinea-Bissau | LOCAL | Agência de Notícias da Guiné (ANG) |
| GY | Guyana | EN | Demerara Waves Online News; Guyana Chronicle; Guyana Times; INews Guyana; Kaieteur News |
| HT | Haiti | LOCAL | Haïti Liberté; Haïti Progrès; Hebdo24; Juno7 |
| HN | Honduras | LOCAL | Confidencial HN; Contexto HN; Criterio.hn; El Libertador |
| HU | Hungary | EN | 24.hu; 444.hu; ATV; HVG; Index.hu; Portfolio.hu; Telex; The Budapest Times; Budapester Zeitung; Népszava |
| IS | Iceland | EN | IceNews; The Reykjavík Grapevine |
| IN | India | EN | Indian Express; The Hindu; Hindustan Times; Indian Express; The Hindu |
| ID | Indonesia | LOCAL | Media Indonesia |
| IR | Iran | EN | Mehr News Agency; Tehran Times |
| IQ | Iraq | EN | Iraqi News |
| IE | Ireland | EN | Donegal Daily; Irish Examiner; The42.ie; TheJournal.ie |
| IL | Israel | EN | Jerusalem Post; Times of Israel; Arutz Sheva (Israel National News); Israel Hayom |
| IT | Italy | EN | The Local Italy |
| JM | Jamaica | EN | Jamaicans.com; McKoysNews; The Jamaica Star |
| JP | Japan | EN | The Japan Times; Japan Wire by Kyodo News; Nikkei Asia; Japan Forward |
| JO | Jordan | EN | Jordan News |
| KZ | Kazakhstan | EN | The Astana Times |
| KE | Kenya | EN | Business Daily Africa; K24 TV; KBC (Kenya Broadcasting Corporation); KTN News; NTV Kenya |
| KI | Kiribati | GAP |  |
| KW | Kuwait | EN | Times Kuwait |
| KG | Kyrgyzstan | EN | Akipress |
| LA | Laos | EN | Laotian Times |
| LV | Latvia | EN | LSM Latvia |
| LB | Lebanon | EN | Naharnet; The961; Ya Libnan; National News Agency (NNA) |
| LS | Lesotho | EN | The Reporter; Public Eye |
| LR | Liberia | EN | Global News Network (GNN Liberia); FrontPage Africa |
| LY | Libya | EN | Libya Herald; Libyan Express; The Libya Update |
| LI | Liechtenstein | GAP |  |
| LT | Lithuania | EN | The Baltic Times |
| LU | Luxembourg | LOCAL | Le Quotidien; Luxemburger Wort; Lëtzebuerger Gemengen; Lëtzebuerger Journal |
| MG | Madagascar | EN | NewsMada |
| MW | Malawi | EN | Malawi Broadcasting Corporation; Malawi Nyasa Times; Malawi Voice; Malawi24; Maravi Express |
| MY | Malaysia | EN | New Straits Times; Daily Express; Malay Mail; MalaysiaNow; The Borneo Post |
| MV | Maldives | EN | Maldives Independent; Maldives Voice; PSM News |
| ML | Mali | LOCAL | Bamada.net; Journal du Mali; Mali Tribune; Mali24 |
| MT | Malta | EN | Gozo News; Lovin Malta; The Shift News |
| MH | Marshall Islands | GAP |  |
| MR | Mauritania | EN | AMI (Agence Mauritanienne d'Information) |
| MU | Mauritius | EN | Mauritius Times |
| MX | Mexico | EN | Mexico News Daily; Banderas News; Cabo News Today; Gringo Gazette; Vallarta Daily |
| FM | Micronesia | GAP |  |
| MD | Moldova | LOCAL | NewsMaker; TV8; UNIMEDIA |
| MC | Monaco | EN | Monaco Life |
| MN | Mongolia | EN | News.MN |
| ME | Montenegro | LOCAL | Adria TV; Borba; Dan; Vijesti |
| MA | Morocco | EN | Morocco World News |
| MZ | Mozambique | EN | Club of Mozambique; Zitamar News |
| MM | Myanmar | EN | Burma News International (BNI); Frontier Myanmar; Myanmar Now; Kachin News Group; Radio Free Asia (RFA) - Myanmar Service |
| NA | Namibia | EN | Namibia Economist; New Era; The Namibian; Windhoek Observer |
| NR | Nauru | GAP |  |
| NP | Nepal | EN | Nepali Times; The Annapurna Express; The Rising Nepal |
| NL | Netherlands | EN | Bellingcat; DutchNews.nl; NL Times |
| NZ | New Zealand | EN | RNZ Pacific; Stuff NZ; BusinessDesk; Farmers Weekly; Newsroom |
| NI | Nicaragua | LOCAL | Artículo 66; Canal 2 (Televicentro); Canal 6 Nicaragua; Confidencial |
| NE | Niger | LOCAL | Agence Nigérienne de Presse (ANP); Journal du niger.com; Niger Inter; Studio Kalangou |
| NG | Nigeria | EN | Premium Times; Sahara Reporters; The Punch; Vanguard News; Business Day |
| KP | North Korea | EXTERNAL |  |
| MK | North Macedonia | LOCAL | Makfax; Nova Makedonija |
| NO | Norway | EN | NewsInEnglish.no; The Local Norway |
| OM | Oman | EN | The Arabian Stories |
| PK | Pakistan | EN | Dawn; Express Tribune; Pakistan Observer; The Frontier Post; The Nation |
| PW | Palau | EN | Island Times |
| PS | Palestine | EN | Palestine News Network |
| PA | Panama | EN | Newsroom Panama |
| PG | Papua New Guinea | EN | Business Advantage PNG; Inside PNG; Papua New Guinea Today; The PNG Bulletin |
| PY | Paraguay | EN | The Paraguay Post |
| PE | Peru | LOCAL | Caretas; El Popular; La República; Perú21 |
| PH | Philippines | EN | Rappler; The Philippine Star; Interaksyon |
| PL | Poland | EN | Notes from Poland |
| PT | Portugal | LOCAL | CNN Portugal; Correio da Manhã; Diário de Coimbra; Diário de Notícias |
| QA | Qatar | EN | Al Jazeera; Doha News; Qatar Department of Foreign Media Affairs |
| CG | Republic of the Congo | LOCAL | CongoPage; Journal de Brazza; Les Dépêches de Brazzaville |
| RO | Romania | EN | Romania Insider |
| RU | Russia | EN | Meduza; Moscow Times; RT International; TASS |
| RW | Rwanda | EN | Taarifa Rwanda |
| WS | Samoa | GAP |  |
| SM | San Marino | LOCAL | Giornale.sm; Libertas.sm; San Marino Fixing; San Marino RTV |
| SA | Saudi Arabia | LOCAL | Al-Watan; Asharq Al-Awsat |
| SN | Senegal | LOCAL | Agence de Presse Senegalaise (APS); Dakaractu; Le Soleil; Leral.net |
| RS | Serbia | LOCAL | B92; Blic; Večernje novosti; N1 Info |
| SC | Seychelles | GAP |  |
| SL | Sierra Leone | EN | Cocorioko; The Calabash Newspaper |
| SG | Singapore | EN | CNA; CNA Latest News; The Independent Singapore |
| SK | Slovakia | LOCAL | Denník N; Hospodárske noviny; Sme; TA3 |
| SI | Slovenia | LOCAL | Delo; Dnevnik; RTV Slovenija; Slovenske novice |
| SB | Solomon Islands | EN | Solomon Times |
| SO | Somalia | EN | Horn Observer; Somali Dispatch; Somali Guardian; Somaliland Standard; The Somali Digest |
| ZA | South Africa | EN | Daily Maverick; GroundUp; IOL; Moneyweb; SABC News |
| KR | South Korea | EN | The Korea Herald; The Korea Times; Yonhap News |
| SS | South Sudan | EN | Catholic Radio Network; Eye Radio; Radio Tamazuj; Sudans Post; The Juba Mirror |
| ES | Spain | EN | El País English |
| LK | Sri Lanka | EN | ITN News; Lanka Business Online; The Island |
| KN | St. Kitts & Nevis | EN | NevisPages.com; SKN News; The St. Kitts-Nevis Observer; Voice of Nevis (VON Radio); ZIZ Broadcasting Corporation |
| LC | St. Lucia | EN | Liberty FM; St Lucia Times; The Voice of Saint Lucia |
| VC | St. Vincent & Grenadines | EN | NBC Radio; Searchlight; St Vincent Times; iWitness News |
| SD | Sudan | EN | Dabanga |
| SR | Suriname | LOCAL | Dagblad Suriname; De Ware Tijd; GFC Nieuws; Key News Suriname |
| SE | Sweden | EN | The Local Sweden |
| CH | Switzerland | EN | The Local Switzerland; Le News |
| SY | Syria | EN | Syria Direct; The Syrian Observer |
| ST | São Tomé & Príncipe | LOCAL | Jornal Tropical; Rádio Somos Todos Primos (RSTP); STP-Press; Téla Nón |
| TJ | Tajikistan | EN | Times of Central Asia |
| TZ | Tanzania | EN | Daily News; TanzaniaInvest; The Chanzo |
| TH | Thailand | EN | Bangkok Post; The Thaiger |
| TL | Timor-Leste | EN | The Dili Weekly |
| TG | Togo | LOCAL | 27avril.com; Togotopnews; Togo‑Presse |
| TO | Tonga | GAP |  |
| TT | Trinidad & Tobago | EN | CNC3 |
| TN | Tunisia | LOCAL | African Manager; Al Chourouk (الشروق); La Presse de Tunisie; Mosaique FM |
| TM | Turkmenistan | EN | News Central Asia |
| TV | Tuvalu | GAP |  |
| TR | Türkiye | EN | Daily Sabah; Daily Sabah |
| UG | Uganda | EN | Business Focus; Daily Express; Eagle Online; Red Pepper; The Independent (Uganda) |
| UA | Ukraine | EN | Kyiv Post; The Kyiv Independent; Ukrainska Pravda (English) |
| AE | United Arab Emirates | EN | The National; Dubai Chronicle; Emirates 24/7; Gulf Today; Khaleej Times |
| GB | United Kingdom | EN | BBC; Guardian; Financial Times; Asharq Al-Awsat; The Guardian International |
| US | United States | EN | NPR; Washington Post World; NPR; Albany Herald; Axios |
| UY | Uruguay | LOCAL | El País; Brecha; El Telégrafo; La Diaria |
| UZ | Uzbekistan | EN | Uzbekistan National News Agency (UzA) |
| VU | Vanuatu | EN | Vanuatu Daily Post |
| VA | Vatican City | EN | Vatican News |
| VE | Venezuela | EN | Venezuela Analysis |
| VN | Vietnam | EN | Vietnam News |
| YE | Yemen | EN | Al-Masirah TV |
| ZM | Zambia | EN | Lusaka Star; Mwebantu; News Diggers!; Zambian Mining News Magazine |
| ZW | Zimbabwe | EN | Bulawayo24 News; DailyNews |

## Az eredeti lista ellenőrzése

| Médium | Eredmény | HTTP | Frissesség |
| --- | --- | --- | --- |
| BBC | xml_ok | 200 | recent |
| Al Jazeera | xml_ok | 200 | recent |
| Guardian | xml_ok | 200 | recent |
| UN News | xml_ok | 200 | recent |
| NPR | xml_ok | 200 | recent |
| BBC Tech | xml_ok | 200 | recent |
| BBC Science | xml_ok | 200 | recent |
| DW | xml_ok | 200 | recent |
| France 24 | xml_ok | 200 | recent |
| Euronews | xml_ok | 200 | recent |
| Balkan Insight | xml_ok | 200 | recent |
| Meduza | xml_ok | 200 | recent |
| Moscow Times | xml_ok | 200 | recent |
| ERR News | xml_ok | 200 | recent |
| Telex | xml_ok | 200 | recent |
| Index.hu | xml_ok | 200 | recent |
| HVG | xml_ok | 200 | recent |
| 444.hu | xml_ok | 200 | recent |
| 24.hu | xml_ok | 200 | recent |
| Portfolio.hu | xml_ok | 200 | recent |
| ATV | xml_ok | 200 | recent |
| Jerusalem Post | xml_ok | 200 | stale |
| The National | xml_ok | 200 | recent |
| Daily Sabah | xml_ok | 200 | recent |
| DW Africa | xml_ok | 200 | recent |
| RFI | xml_ok | 200 | recent |
| Africa News | xml_ok | 200 | recent |
| NYT Africa | not_feed | 200 |  |
| NYT Asia | not_feed | 200 |  |
| SBS Australia | xml_ok | 200 | recent |
| ABC Australia | xml_ok | 200 | recent |
| CNA | xml_ok | 200 | recent |
| The Diplomat | xml_ok | 200 | recent |
| Dawn | xml_ok | 200 | recent |
| Indian Express | xml_ok | 200 | recent |
| The Hindu | xml_ok | 200 | recent |
| MercoPress | xml_ok | 200 | recent |
| Mexico News Daily | xml_ok | 200 | recent |
| InSight Crime | xml_ok | 200 | recent |
| Defense One | xml_ok | 200 | recent |
| The War Zone | xml_ok | 200 | recent |
| Breaking Defense | xml_ok | 200 | recent |
| War on the Rocks | xml_ok | 200 | recent |
| Crisis Group | xml_ok | 200 | unknown |
| Oryx | xml_ok | 200 | stale |
| IAEA | xml_ok | 200 | unknown |
| WHO News | xml_ok | 200 | stale |
| Krebs | xml_ok | 200 | recent |
| OilPrice | xml_ok | 200 | recent |
| NYT Americas | not_feed | 200 |  |
| Foreign Policy | http_error | 403 |  |
| NYT | not_feed | 200 |  |

## Opcionális teljes országkeresés

A CSV minden országhoz tartalmaz angol Google News kereső-feed URL-t. Ezek generált keresések, nem helyi lapok hivatalos RSS-ei. A tíz hiányos alapország keresése külön is sikeres HTTP/XML/cikk/frissesség ellenőrzést kapott; az eredmény a `search-audit.json` fájlban van. A többi ország keresőfeedjét nem teszteltük külön. A találatokban félreértett országnevek, ismétlések és régi cikkek is előfordulhatnak. Nincs fordítás: az angol keresés csak az elérhető angol találatokat célozza.

## Üzemeltetés

Szerveroldali/proxys letöltést használj, ha a böngésző CORS miatt blokkol. A kezdeti ellenőrzés után érdemes az 5xx/timeouts hibákat újrapróbálni, az ETag/Last-Modified fejléceket kezelni, és az URL/kiadó/cikk alapján deduplikálni. A regionális feedeket egyszer töltsd le, ne minden lefedett ország után külön. A napi pár cikket kiadó médiumokat ne tekintsd hibásnak csak azért, mert 24 óránál régebbi a legújabb hírük.

## Forrásjegyzék és eredet

- A felhasználó által megadott eredeti 52 feed.
- https://github.com/Rybatter50-cloud/Feeds/blob/main/9_30_2026_feed_sources.csv – ország/nyelv szerinti jelöltek; a korábbi probe értékeket nem vettük át mai ellenőrzésként.
- https://github.com/yavuz/news-feed-list-of-countries – másodlagos felfedezési forrás.
- https://github.com/datasets/country-codes – ISO/M49 ország- és régiólista, külön UN195 kiválasztással.
- https://www.lemonde.fr/en/about-us/article/2026/03/27/le-monde-rss-feeds_6751860_115.html – angol RSS dokumentáció.
- https://www.channelnewsasia.com/rss – hivatalos RSS információ.
- A kiadói végpontok közvetlen HTTP/XML ellenőrzése; részletek a `registry.json` fájlban.

A forráslisták jelölteket szolgáltatnak, nem szerkesztőségi minősítést. A teljes eredeti külső adatbázisokat nem másoltuk a csomagba.
