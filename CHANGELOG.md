# Changelog

All notable changes to Compute Atlas are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0](https://github.com/ek33450505/compute-atlas/compare/ai-datacenter-tracker-v1.1.0...ai-datacenter-tracker-v1.2.0) (2026-07-28)


### Features

* **about,contribute:** add maintainer bio + Support-the-atlas sponsor blocks ([b529c88](https://github.com/ek33450505/compute-atlas/commit/b529c88cf4e3006a142de78a9c14eb8f71826826))
* **about:** open the mission statement with an engraved versal drop-cap ([5485476](https://github.com/ek33450505/compute-atlas/commit/54854762da035447c292ad8e4e3bb08b1ea0b4c4))
* **about:** rewrite About page as manifesto with atlas re-skin ([cc4ca01](https://github.com/ek33450505/compute-atlas/commit/cc4ca011cb71d089a4f42db0d1103a8fb1b29ca0))
* **activity:** add recent activity feed page combining facility updates and submissions ([1d22284](https://github.com/ek33450505/compute-atlas/commit/1d222844aea215bb3dc964b483a7bc195dc31cef))
* **activity:** add RSS feed for the recent-activity stream ([7a2096c](https://github.com/ek33450505/compute-atlas/commit/7a2096c4e639235f45c6084feb681723ee861204))
* **activity:** capture and surface opt-in contributor attribution ([60a4c06](https://github.com/ek33450505/compute-atlas/commit/60a4c062aefec2edfcae62f08c3d7aa2c5b0e22c))
* **activity:** display contributor attribution on the feed and forms ([88455a4](https://github.com/ek33450505/compute-atlas/commit/88455a413db90499136ba81a10c88d266e5c0fd9))
* **admin/facilities:** complete admin facility editor with energy/water/jobs/community fieldsets ([75ff92c](https://github.com/ek33450505/compute-atlas/commit/75ff92cf6e137b0916c6431d2034209334ae6d87))
* **admin:** add facility create/edit form (Phase 2b-1) ([a05c433](https://github.com/ek33450505/compute-atlas/commit/a05c43390021bd4f60a3bb0a63c14934db5830c0))
* **admin:** add facility editor array controls and source-index picker ([af1ae27](https://github.com/ek33450505/compute-atlas/commit/af1ae278c938a00709ea779833662b5d86e6f853))
* **admin:** add facility history panel with computed-diff storage ([b6cabeb](https://github.com/ek33450505/compute-atlas/commit/b6cabeb0b5eabdbe22c8324b2bc5921172aaa4f6))
* **admin:** add facility list + delete page ([0dc6670](https://github.com/ek33450505/compute-atlas/commit/0dc667020d3e83849fc400de694438553b47e097))
* **admin:** add sources[] array editor to facility form ([be8b43c](https://github.com/ek33450505/compute-atlas/commit/be8b43ca4a412300fc222566c78eafc5f9d295e9))
* **admin:** add submissions review UI with approval/reject actions ([e4c8d14](https://github.com/ek33450505/compute-atlas/commit/e4c8d14c394d6608ab9149191c3e8b5dd191c20a))
* **admin:** facility_history audit table + write-path integration ([6606b7b](https://github.com/ek33450505/compute-atlas/commit/6606b7ba006028aaf188283887786175851f200d))
* **admin:** implement Phase 0 auth gate for admin routes ([ea9dd70](https://github.com/ek33450505/compute-atlas/commit/ea9dd70d4d235f9c390c6ed62356f37537447680))
* **api:** add admin-authenticated facility write API ([6243b79](https://github.com/ek33450505/compute-atlas/commit/6243b791cb4278e78e4107056f5373d72133cff2))
* **api:** add an /api documentation page ([0100dda](https://github.com/ek33450505/compute-atlas/commit/0100dda64d600e328d7cf5fc64d78be808981aa9))
* **api:** add human-gated submissions staging layer ([770b530](https://github.com/ek33450505/compute-atlas/commit/770b530dcfb9f3e0511f155969083bbea923af32))
* **api:** add public read API for facilities, stats, and schema ([0eb1ac6](https://github.com/ek33450505/compute-atlas/commit/0eb1ac6b5a1f3de5e00a5c5a9193024f8f5d65be))
* **atlas:** add accessible data table with filters for compute facilities ([7d4038d](https://github.com/ek33450505/compute-atlas/commit/7d4038dcc7c7303cd15869bbec45fcfa2c4a5dbe))
* **atlas:** add facility data model and validated loader ([98d857c](https://github.com/ek33450505/compute-atlas/commit/98d857cfa201d2750fbd3f9edf8c82e6b5a73df8))
* **brand:** ⌖ favicon + apple-icon, reusable Wordmark, streamlined header ([e2a7dee](https://github.com/ek33450505/compute-atlas/commit/e2a7dee70df9a2d59b9fa685e99f42b917bd0b3e))
* **civic-impact:** add mining and environmental rendering, fix hasCivicImpact gate ([c54c421](https://github.com/ek33450505/compute-atlas/commit/c54c421a36fdb2f799a0685daaa17f1bc06a373a))
* **compute-atlas:** add interactive facility map view ([6bb5744](https://github.com/ek33450505/compute-atlas/commit/6bb57441423b578c2000b817b4328e000c6ef191))
* **contribute:** issue-form templates + footer CTA; focus home hero; prune next-themes ([8439582](https://github.com/ek33450505/compute-atlas/commit/84395825e67a33189148ab0f1257292f6c8f414c))
* **data:** add Rhode Island + South Dakota facilities (142 facilities, 47 states) ([66e7131](https://github.com/ek33450505/compute-atlas/commit/66e7131b04ea35d28ef0a5e97498c164717594f6))
* **data:** convert facility data-access layer to async with Neon read path ([6cd83cb](https://github.com/ek33450505/compute-atlas/commit/6cd83cbd7b0d2a587eb298158fa6ce8b8ba52145))
* **data:** enrich civic-impact fields for 10 flagship AI-datacenter campuses ([683c172](https://github.com/ek33450505/compute-atlas/commit/683c1724169b9d9c51ca949254cd8e14b5734305))
* **data:** enrich civic-impact fields for 4 mid-tier campuses (Wave 2) ([d2cbd16](https://github.com/ek33450505/compute-atlas/commit/d2cbd16b90148231d57f55c4feb4e2f687844815))
* **data:** enrich civic-impact fields for 6 major-operator campuses (Wave 1) ([b6a1925](https://github.com/ek33450505/compute-atlas/commit/b6a1925d8a4d62aae788486ca3f682230f402485))
* **data:** enrich civic-impact fields for the sparse tier (Wave 3) ([d72fc80](https://github.com/ek33450505/compute-atlas/commit/d72fc8075b5ec9d5f53334dffa3f2bfefe9789a9))
* **data:** expand facilities with 22 real US AI datacenters ([4441e32](https://github.com/ek33450505/compute-atlas/commit/4441e32014ee7c0c3740a0999f2733c30b154412))
* **data:** expand tracker to 139 facilities across 46 states ([2766428](https://github.com/ek33450505/compute-atlas/commit/2766428771829ce7f91486884daec7cce1870acb))
* **data:** source-verify civic fields for 6 civic≤1 campuses (Wave 1) ([6297bd8](https://github.com/ek33450505/compute-atlas/commit/6297bd8943f48d862daba802c5f7e0d7eab59813))
* **data:** source-verify civic fields for 8 civic≤1 campuses (Wave 2) ([d52ce34](https://github.com/ek33450505/compute-atlas/commit/d52ce341557ea3ff21934a288a454682d0a1bb8a))
* **data:** source-verify civic-impact fields for 10 remaining 0-civic campuses (Wave 2) ([5c294ab](https://github.com/ek33450505/compute-atlas/commit/5c294ab300e99a64f8dbbde517c3c6fd17394ca0))
* **data:** source-verify civic-impact fields for 6 flagship 0-civic campuses (Wave 1) ([f93d90d](https://github.com/ek33450505/compute-atlas/commit/f93d90d78db8199a955bf01813fc973ce5a7219e))
* **db:** add db:export to regenerate the facilities.json snapshot ([3a5798c](https://github.com/ek33450505/compute-atlas/commit/3a5798c58061d01954acedd6456b3acae3623048))
* **db:** add Neon Postgres foundation with Drizzle schema, client, and seed ([ab1267c](https://github.com/ek33450505/compute-atlas/commit/ab1267c642e121d3529dcc28197fff4c00de494a))
* **db:** add subscriptions table + migration for email watch-lists ([8a4310d](https://github.com/ek33450505/compute-atlas/commit/8a4310d1f7106fa16218efaef40f7f9623bec7b5))
* **design:** cartographic survey atlas design-system spike ([7814e59](https://github.com/ek33450505/compute-atlas/commit/7814e59892fdf4e9de085f826df019cda114a19f))
* **discovery:** add local human-gated discovery pipeline ([ea803b6](https://github.com/ek33450505/compute-atlas/commit/ea803b689fb0c229d1040b4aef09802c8034d337))
* **discovery:** add mechanical source-liveness checker ([c6cf5db](https://github.com/ek33450505/compute-atlas/commit/c6cf5dbb07101764f0011384eff73e4c87440b87))
* **discovery:** close the data loop — combined new+update pass + source-liveness ([b2a4d75](https://github.com/ek33450505/compute-atlas/commit/b2a4d75224622c92ba717e165e4e87c79dd4ae63))
* **discovery:** combined new+update pass with existing-facilities projection ([9a8f3ce](https://github.com/ek33450505/compute-atlas/commit/9a8f3ceebb29a3dc691244a70ed7f0c9e6708c31))
* **email:** add Resend wrapper, token generator + subscribe rate-limiter ([860e805](https://github.com/ek33450505/compute-atlas/commit/860e80569f104102b3a4bc4dc0236cd06e399ba5))
* **explore:** add API lens card to /explore landing page ([#3](https://github.com/ek33450505/compute-atlas/issues/3)) ([0a56e0c](https://github.com/ek33450505/compute-atlas/commit/0a56e0cfbff08c81285d36b6e59ee30e908a3a51))
* **explorer:** add client-side data explorer for homepage ([34e8742](https://github.com/ek33450505/compute-atlas/commit/34e874232eb29e32e699af52714e4c40b587a402))
* **facilities:** add static detail pages with timeline & provenance ([c2c6d91](https://github.com/ek33450505/compute-atlas/commit/c2c6d914af55c33dd2e8db4a9a4ce6858b1b2f5d))
* **facility-type:** add facility type metadata module and UI badge ([949faaa](https://github.com/ek33450505/compute-atlas/commit/949faaa58a3ee19faa14811dd116b2654a64e5e7))
* **facility:** re-skin detail page as atlas plate; fix back-link to /map ([1318adb](https://github.com/ek33450505/compute-atlas/commit/1318adb02035d1c1b40a95ec3328dc56e54381bd))
* **facility:** surface civic-impact fields on facility detail page ([6685075](https://github.com/ek33450505/compute-atlas/commit/66850750ba52b746e76eaaa1dfd8ba24945cd5c9))
* **footer:** align to page content width; add Sponsor CTA + OSM link ([c8d4f8e](https://github.com/ek33450505/compute-atlas/commit/c8d4f8e6e943a9bed85ead6eb4388cb67682fe3f))
* **footer:** redesign site footer as cartographic colophon ([473e9af](https://github.com/ek33450505/compute-atlas/commit/473e9af18b8064fa88143ee970298c257655e32f))
* **graticule:** unify the hero grid on GraticuleSurvey and darken it for legibility ([9f16823](https://github.com/ek33450505/compute-atlas/commit/9f168237f6f61b36002ebf7fd5a366b9d29995ad))
* **home:** draw the hero graticule in on load as a self-surveyed grid ([f26673d](https://github.com/ek33450505/compute-atlas/commit/f26673dbcf2e73dc4c693313946a5fac762bb6c1))
* **home:** re-voice hero — open-atlas headline + community-balanced subhead ([67cb4ae](https://github.com/ek33450505/compute-atlas/commit/67cb4aeacaf757c689ed3b81d9fd8111ffac339d))
* **home:** re-voice hero on the public-but-scattered mission; add Contribute link ([37cd672](https://github.com/ek33450505/compute-atlas/commit/37cd67236245daf992e91501760be86f6201c130))
* **map:** add 3D globe projection, location search, and state-level marker clustering ([0e3c2ec](https://github.com/ek33450505/compute-atlas/commit/0e3c2ec0de594bff9e0c027e8060720b462a01e0))
* **map:** add a living survey graticule and live pointer coordinate readout ([0cc8cb0](https://github.com/ek33450505/compute-atlas/commit/0cc8cb0da825367d366f8bd87e9d61b5132a6c49))
* **map:** add a locator inset overview with a live viewport indicator ([3c61787](https://github.com/ek33450505/compute-atlas/commit/3c61787b11e4051b5bd2034f4fe10e80c5520979))
* **map:** add Esri satellite basemap with streets/satellite toggle ([795bc0d](https://github.com/ek33450505/compute-atlas/commit/795bc0d4c50ca6018b408e65eb02b332611e7345))
* **map:** cluster markers for accessible display at 139-facility scale ([6dcaccc](https://github.com/ek33450505/compute-atlas/commit/6dcaccc3c4c617a7726733b279d874639e11a2b4))
* **map:** distinguish facility types with shape-based markers ([7db2064](https://github.com/ek33450505/compute-atlas/commit/7db2064c5d574e26bd59fd8b8312a2a2bb9f32f4))
* **map:** immersive full-bleed /map with collapsible filter sub-header ([2958497](https://github.com/ek33450505/compute-atlas/commit/2958497b2f367943d194cb9567fefad701198ce0))
* **map:** redraw the legend as an engraved Key to Symbols print key ([820446e](https://github.com/ek33450505/compute-atlas/commit/820446e663bc776d4329be762d7cfcc3d5a705b2))
* **map:** remove the locator inset overview ([7134be6](https://github.com/ek33450505/compute-atlas/commit/7134be62ede2a751f017e8408fa4665a4ac7a3d5))
* **map:** replace sepia stopgap with custom parchment MapLibre style ([af09fa1](https://github.com/ek33450505/compute-atlas/commit/af09fa1dad8ba35968eb26db9c242c50723fce82))
* **map:** survey-pass the camera to the filtered facility set ([3d5d5ad](https://github.com/ek33450505/compute-atlas/commit/3d5d5ad61d102ba98a61bd0034f967039bc866a7))
* **map:** theme facility popup as a parchment atlas card (Track B 1b) ([c08a237](https://github.com/ek33450505/compute-atlas/commit/c08a237fe18868f44a1e67c57d3b1ab3597adc67))
* **methodology:** add data-dictionary page and slim About to its mission ([6cc4379](https://github.com/ek33450505/compute-atlas/commit/6cc43792cf1d8392358812276f9e7a3cf29f3fbf))
* **mobile:** add mobile navigation menu for responsive layout ([1672f1c](https://github.com/ek33450505/compute-atlas/commit/1672f1cf8291f66744dea1e080f7617d8b86c1e2))
* **nav:** group data-lens pages under an Explore dropdown menu ([04c2a05](https://github.com/ek33450505/compute-atlas/commit/04c2a05e1786a7fa0fbf1ade53e517aad903f3be))
* **nav:** replace back-links with breadcrumb trails across all sub-pages ([84056ae](https://github.com/ek33450505/compute-atlas/commit/84056ae14a1452b6f7275cbf7cdba97df2610c3c))
* **nav:** surface the activity feed and Discussions in site chrome ([97abfe4](https://github.com/ek33450505/compute-atlas/commit/97abfe480def7cfbcee44863809111467dc8bdac))
* **og:** render social-card wordmark in the bundled Fraunces serif ([ed111db](https://github.com/ek33450505/compute-atlas/commit/ed111db09b2be53a856ffd624fc21585a7260679))
* **og:** restyle social card to the atlas system ([001c811](https://github.com/ek33450505/compute-atlas/commit/001c81178d8787412542105de4264a61997094ee))
* **operators:** add operator profile pages and index ([d9637a4](https://github.com/ek33450505/compute-atlas/commit/d9637a4077e889fd376c7dba89cd176b8842dc5b))
* **operators:** sort by capacity and collapse zero-capacity operators ([a023c8f](https://github.com/ek33450505/compute-atlas/commit/a023c8f2c9f8ac32c0dc6c90d1ca2837819f51d4))
* **opposition:** add community-friction page and move Explore menu after Stats ([c15f1fb](https://github.com/ek33450505/compute-atlas/commit/c15f1fb66f96707880f9393b81ee6c87ef25c504))
* **power:** add /power generation view grouped by offtaker and technology ([3b5ec17](https://github.com/ek33450505/compute-atlas/commit/3b5ec172447c858beba397131ae467bc13719ab7))
* **power:** add sourced facility power-links data layer ([61187c6](https://github.com/ek33450505/compute-atlas/commit/61187c6b8a8703b3d590cf11acd0d546f4aa9b85))
* **power:** link facilities to the plants that power them on detail pages ([f73e0df](https://github.com/ek33450505/compute-atlas/commit/f73e0dfbef4742f54af6c8141afaae7c7a4cb409))
* public contribution portal — suggest a facility + per-facility corrections ([#18](https://github.com/ek33450505/compute-atlas/issues/18)) ([025d24e](https://github.com/ek33450505/compute-atlas/commit/025d24eb2cac0f327a423a863a447e39c947fb60))
* **schema:** add facilityType discriminated union for crypto-mining + environmental metrics ([efacf48](https://github.com/ek33450505/compute-atlas/commit/efacf48bc5ae4587489dc615f70f49abb7cb74c5))
* **schema:** add location precision/multi-site and eGRID carbon lookup ([c2c04d3](https://github.com/ek33450505/compute-atlas/commit/c2c04d30c237cdc15049fc7c3ea00da8c3bf02c2))
* **schema:** add optional civic-impact fields (energy, water, subsidies, economics, community) ([a465fe2](https://github.com/ek33450505/compute-atlas/commit/a465fe256e112eb26a73c7bbcab006fcb2ad5854))
* **schema:** add optional location.street/postalCode, surface on facility page, search + SEO ([#30](https://github.com/ek33450505/compute-atlas/issues/30)) ([33e0a0b](https://github.com/ek33450505/compute-atlas/commit/33e0a0b7cbf0281c1588f02188fbf564128626f5))
* **schema:** add power_generation facility type and intake Oklo Aurora nuclear campus ([bb1c96c](https://github.com/ek33450505/compute-atlas/commit/bb1c96c6c17810135ecdf1f05cd2740c64af450a))
* **schema:** broaden framing from AI-specific to any data center type ([63324a2](https://github.com/ek33450505/compute-atlas/commit/63324a22d5d009c0332a57698842df59154bc953))
* **search:** add a site-wide ⌘K command palette for search and navigation ([3361c46](https://github.com/ek33450505/compute-atlas/commit/3361c46d5923b0630f41b2439e364f531893728f))
* **search:** add full-text search vector indexing for facilities ([cad44e0](https://github.com/ek33450505/compute-atlas/commit/cad44e0ba8e04cee29902fa224f57b18c00b393d))
* **search:** wire DB full-text search into the ⌘K command palette ([194e319](https://github.com/ek33450505/compute-atlas/commit/194e3192f26a5c7546a554f3b150ff354d4c81ed))
* **seo:** add about page, sitemap, robots, og, json-ld ([83ce2be](https://github.com/ek33450505/compute-atlas/commit/83ce2bee8adc8ff1dc07c93e12c631d9e229b814))
* **seo:** add by-metro landing pages for 27 US data center metros ([fd6a827](https://github.com/ek33450505/compute-atlas/commit/fd6a82757f9c5ac96a4a2df180daa12f1d7c8c4a))
* **seo:** add by-status landing pages + shared CollectionPage ([42777fe](https://github.com/ek33450505/compute-atlas/commit/42777fe1699645c0386164317b573c95fe73a708))
* **seo:** add Dataset JSON-LD + Twitter card, fix OG image domain ([#17](https://github.com/ek33450505/compute-atlas/issues/17)) ([356f7da](https://github.com/ek33450505/compute-atlas/commit/356f7da45b7d46c9e41384450f0e4dbc6ec9be76))
* **seo:** add metro data model + by-metro query helper ([09542ec](https://github.com/ek33450505/compute-atlas/commit/09542ec9b86b9ff9e49d88ffb302eb284dd5ab33))
* **seo:** add Organization, WebSite & ItemList structured data ([3822161](https://github.com/ek33450505/compute-atlas/commit/3822161c7426f9e3ff832e87a401662c665be613))
* **seo:** add per-route canonical URLs ([a649d7f](https://github.com/ek33450505/compute-atlas/commit/a649d7ff8e7bcd7c6649732cdf068f3f5d8ed10a))
* **seo:** crawl & index hygiene for robots + sitemap ([ded6c71](https://github.com/ek33450505/compute-atlas/commit/ded6c71b41646faf810453e7249125797a9814bd))
* **seo:** keyword-rich titles for hub, lens & home pages ([bd93245](https://github.com/ek33450505/compute-atlas/commit/bd93245042b4f270f1a72c1bdad0fc4403bdf5ba))
* **seo:** rewrite facility titles + descriptions for search CTR ([c31c645](https://github.com/ek33450505/compute-atlas/commit/c31c6451ca8dfaaa980de6177e0b112a0578cc5e))
* **seo:** set canonical domain, disallow pre-launch indexing, add /map + /stats to sitemap ([259e654](https://github.com/ek33450505/compute-atlas/commit/259e65441e75fe0c16907f9831a6787e2cd14350))
* **seo:** turn facility pages into engagement hubs ([2a6d243](https://github.com/ek33450505/compute-atlas/commit/2a6d243d275ebb8a6661ad94f556c64eb661995e))
* sponsorship / support surfaces (maintainer bio + Support-the-atlas) ([c7d9545](https://github.com/ek33450505/compute-atlas/commit/c7d95457cb88c2fd4289dbfe2eefaa4534a15dbc))
* **states:** add per-state landing pages, states index, and sitemap routes ([c4cb033](https://github.com/ek33450505/compute-atlas/commit/c4cb0339f342270c53abd9cceff9f5177c0a860b))
* **states:** add state name/slug maps and per-state data aggregators ([0d99f38](https://github.com/ek33450505/compute-atlas/commit/0d99f383f1fe19a6292413771f6aaac547a5145c))
* **stats:** add facility-type and community-reception breakdowns and under-construction stat ([a28a478](https://github.com/ek33450505/compute-atlas/commit/a28a4785e3788deb1bf4d71fbaa78ec9fe976ae1))
* **stats:** add Track B aggregate statistics page ([55cc919](https://github.com/ek33450505/compute-atlas/commit/55cc9193197e80b418df1e16c4ff3a94fedf770e))
* **stats:** add water use reporting section with cooling-method breakdown ([877940b](https://github.com/ek33450505/compute-atlas/commit/877940b7a7e95b0df5a33b3dc4d001f1929bcf3d))
* **subscribe:** add subscribe/confirm/unsubscribe backend with double-opt-in ([d5d240c](https://github.com/ek33450505/compute-atlas/commit/d5d240c77395aa9161f411dc3eb9962c61507e67))
* **subscribe:** add Watch button UI, status pages + page mounts ([c64a147](https://github.com/ek33450505/compute-atlas/commit/c64a1474703fca0ba22f9fc55dba4ddcf0f3ff12))
* **subscribe:** notify confirmed subscribers when a change is approved ([a79e01a](https://github.com/ek33450505/compute-atlas/commit/a79e01a286a9bf551250e58637c8fba4f5e09a7f))
* **table:** add filter-aware CSV/JSON dataset export ([a7446e9](https://github.com/ek33450505/compute-atlas/commit/a7446e9f8a3f149d2bb528373e760007aeddd8a9))
* **table:** add sortable confidence/updated columns and density tightening ([50867d3](https://github.com/ek33450505/compute-atlas/commit/50867d32fdf0773647ec3166069773c0f0ce9ce5))
* **table:** default /table sort to capacity descending, no-capacity rows last ([8797371](https://github.com/ek33450505/compute-atlas/commit/87973719a382d96e5d8272395874948623277775))
* **table:** filterable /table sharing the map filter state + atlas re-skin ([b78762b](https://github.com/ek33450505/compute-atlas/commit/b78762b929500307cc7a446913fa76348dd29daa))
* **ui:** split landing into editorial Home and immersive Map pages ([5e39e55](https://github.com/ek33450505/compute-atlas/commit/5e39e556ad2dbb0eddd14a7a58df6ed7bb19635b))
* **ux:** graceful degradation — error/404 boundaries, loading skeletons, empty states ([669eb49](https://github.com/ek33450505/compute-atlas/commit/669eb494ccbc78048faa32e0f22966de5fe713f2))
* **ux:** progressive "Show more" reveal for long facility lists ([3070273](https://github.com/ek33450505/compute-atlas/commit/3070273777898de1d4b912d15696eb70637f931b))
* **ux:** shareable-link button + print-friendly facility pages ([b8dcc50](https://github.com/ek33450505/compute-atlas/commit/b8dcc50fc98093117006fc933b84791cae374554))
* Wave B — harden + document the public read API (caching-first + rate-limited) ([#41](https://github.com/ek33450505/compute-atlas/issues/41)) ([b78cd0f](https://github.com/ek33450505/compute-atlas/commit/b78cd0f219b3c1c927a575a2061398fc1ebc0d01))
* Wave C — email alerts (watch a facility / state / all; double-opt-in) ([696b97c](https://github.com/ek33450505/compute-atlas/commit/696b97ca968a7be130b5c07d7d62df329dd5d2f3))
* **wordmark:** draw the datum mark in on load ([9a57ae1](https://github.com/ek33450505/compute-atlas/commit/9a57ae1e7c06e9f019bcf06921f032871808eb7b))


### Bug Fixes

* **a11y:** add aria-labels to dialog close button and submission row toggles ([ba33a2a](https://github.com/ek33450505/compute-atlas/commit/ba33a2ab6fe295568bdb6ebc6b7f24082223e3e7))
* **a11y:** add focus-visible ring to About's Methodology link ([60bf0fc](https://github.com/ek33450505/compute-atlas/commit/60bf0fcc037fd08c9efbfb62c567c81731a6ce8f))
* **a11y:** darken cancelled status color for red-green separation ([1f99857](https://github.com/ek33450505/compute-atlas/commit/1f99857e8ad5ca53ff95ddcda7ec21a37c67c71a))
* **a11y:** gate continuous animations behind prefers-reduced-motion ([c4fcaca](https://github.com/ek33450505/compute-atlas/commit/c4fcaca7d585cc457037ccdbef972c77befd7b6c))
* **a11y:** gate overlay enter/exit animations behind reduced-motion ([98d00e2](https://github.com/ek33450505/compute-atlas/commit/98d00e2160f41e47ba74a9ec0048a4622bdfd816))
* **a11y:** gate transition-based overlays behind reduced-motion ([5279e02](https://github.com/ek33450505/compute-atlas/commit/5279e021323c95915f797db0a79178155e3c6ec2))
* **a11y:** render basemap attribution below map to fix marker target-size collision ([b3de51b](https://github.com/ek33450505/compute-atlas/commit/b3de51b5f4831a275ac353da9f749583eb523be4))
* **a11y:** resolve WCAG 2.2 AA color contrast and interactive nesting violations ([402fc0b](https://github.com/ek33450505/compute-atlas/commit/402fc0b6d7380c25185da09200e6f1c57c9a7b45))
* **admin-ui:** extract RSC-incompatible form helpers to client-boundary-safe module ([fd01427](https://github.com/ek33450505/compute-atlas/commit/fd014276b64c6e8eb56fb427cce31f49aae303c5))
* **admin:** add accessibility attributes to facility form inputs ([7d3f5da](https://github.com/ek33450505/compute-atlas/commit/7d3f5dac73470a886f1906b2195b1cb8db980d27))
* **admin:** render submission detail via server ancestor to fix RSC boundary ([325c721](https://github.com/ek33450505/compute-atlas/commit/325c7214369aa404841ebd883c0943385d856211))
* **admin:** validate hashRateThPerS/subsidies.year + restore array-editor focus (§1f) ([#23](https://github.com/ek33450505/compute-atlas/issues/23)) ([39b21e6](https://github.com/ek33450505/compute-atlas/commit/39b21e6887cd60db877e6b88fb5c3a2a6d8b4267))
* **admin:** wrap AdminLoginPage in Suspense boundary for Next.js 16 static prerendering ([8cf2cd2](https://github.com/ek33450505/compute-atlas/commit/8cf2cd274e59811a55ae354ced7b8a9989071d3b))
* **cache:** scope ISR revalidation to end free-tier write blowout ([#28](https://github.com/ek33450505/compute-atlas/issues/28)) ([38ba799](https://github.com/ek33450505/compute-atlas/commit/38ba799e8149d2418d8cd76f4d97410e1b19b09d))
* **data:** degrade recent-activity feed to empty on live DB failure ([bcb3dd6](https://github.com/ek33450505/compute-atlas/commit/bcb3dd6044342b5f7cbf1bdaf935fa26ca89679e))
* discovery retry-on-empty + admin table sticky-header/scroll ([#25](https://github.com/ek33450505/compute-atlas/issues/25)) ([6751ec5](https://github.com/ek33450505/compute-atlas/commit/6751ec52a31e6386a99da8c8b9278f6cfb945d66))
* **discovery:** faithful append-only status updates (fixes sourceIndex orphaning on approve) ([#26](https://github.com/ek33450505/compute-atlas/issues/26)) ([b68eb16](https://github.com/ek33450505/compute-atlas/commit/b68eb1624505b952a436fa6a2be1d5e18078c4a3))
* **discovery:** force JSON-only output + move schedule to 13:00 ([#19](https://github.com/ek33450505/compute-atlas/issues/19)) ([67470cf](https://github.com/ek33450505/compute-atlas/commit/67470cf3b39b7efdfdf7261dbd8fd730de081c00))
* **discovery:** SSRF guard, projection escaping + source-liveness WARN ([#22](https://github.com/ek33450505/compute-atlas/issues/22)) ([ef5c6e1](https://github.com/ek33450505/compute-atlas/commit/ef5c6e1f729aeb39cba353788871ba2f57ac098b))
* **discovery:** tolerate claude -p preamble + wire daily pipeline schedule ([8a87265](https://github.com/ek33450505/compute-atlas/commit/8a872658acb0ce6c8201e86df40a50ca8278ed66))
* **discovery:** tolerate prose preamble in claude -p output; close stdin in run.sh ([7c133c8](https://github.com/ek33450505/compute-atlas/commit/7c133c841c6ced486ffc2594de7fb75214802cf0))
* **discovery:** wire existing-facilities projection into discovery prompt ([9f5b5ef](https://github.com/ek33450505/compute-atlas/commit/9f5b5ef2ac2b85c507331f7ad7c6e35af327a159))
* **facility:** render energy.utility independently of energy.source ([#31](https://github.com/ek33450505/compute-atlas/issues/31)) ([90ba91c](https://github.com/ek33450505/compute-atlas/commit/90ba91cf0d9daf89c83443932a6f176a08eb434f))
* **header:** responsive mobile layout — eliminate horizontal overflow ([013ab2a](https://github.com/ek33450505/compute-atlas/commit/013ab2a62f3c7fcc6514afa9c2b1a4635b118849))
* **home:** split capacity stat into honest operational vs planned GW ([eed2c97](https://github.com/ek33450505/compute-atlas/commit/eed2c9753ea49d15a65f607ef3fddcf3665d2feb))
* **home:** stop notable-sites cards overflowing on narrow mobile ([a491dea](https://github.com/ek33450505/compute-atlas/commit/a491dea618d668614d4d4f7b2c59ec91f8727554))
* **map:** restore "facilities" in sub-header result count ([2345277](https://github.com/ek33450505/compute-atlas/commit/2345277f646d911f49e2cda8c5face8dd92ad228))
* **nav:** point About back-link to /map instead of home ([1e9240c](https://github.com/ek33450505/compute-atlas/commit/1e9240cebed6098978884da0d4a03d6f7b74f89e))
* **schema:** restrict source.url to http/https to close XSS vector ([#15](https://github.com/ek33450505/compute-atlas/issues/15)) ([2e4b3b9](https://github.com/ek33450505/compute-atlas/commit/2e4b3b9d59b431194045fb35d83370557e260936))
* **states:** add DC to state map and harden generateStaticParams ([e28ee01](https://github.com/ek33450505/compute-atlas/commit/e28ee01a85623623f63833082d8d44c40f34ce76))
* **stats:** add explicit space after facility count in water context ([f4ccf8d](https://github.com/ek33450505/compute-atlas/commit/f4ccf8de8d1ff70f82cf5275ea377b1e32c14cd5))
* **subscribe:** harden email endpoint — off-path send (timing) + per-email cap + safe logs ([1d237e8](https://github.com/ek33450505/compute-atlas/commit/1d237e80bc468f08385465989fe8550704f7f548))
* **ui:** bound ScrollArea viewport height so facet popovers scroll instead of spilling ([76751ad](https://github.com/ek33450505/compute-atlas/commit/76751ada043912521640bd62d75a4e75d97912c7))
* **ui:** render Separator via data-[orientation] variants ([78bdbd1](https://github.com/ek33450505/compute-atlas/commit/78bdbd1b8c1b60f48450996e83ebf124ac46975c))


### Reverts

* **seo:** reopen crawling — allow-all robots + sitemap (keep Vercel deploy public) ([f34030b](https://github.com/ek33450505/compute-atlas/commit/f34030b6c4b3c92790acccd5ae96f01fcd6a3240))

## [Unreleased]

## [1.1.0] - 2026-07-28

### Added

- **Public read API** with caching-first design: `GET /api/facilities`, `/api/stats`, `/api/schema` with edge-cache headers and per-IP rate limiting.
- **Email watch alerts** — double-opt-in subscription for facility changes, state-wide updates, or site-wide digest.
- **RSS feed** for recent activity (`/activity/feed.xml`) with contributor attribution.
- **Opt-in contributor attribution** displayed on activity feed and submission forms.
- **Sponsorship surfaces** — maintainer bio and support-the-atlas blocks on `/about` and `/contribute`.
- **SEO growth pages** — by-status (`/status/*`) and by-metro (`/metros/*`) landing pages with shared CollectionPage template.
- **Per-route canonical URLs** for search engines.
- **Structured data (JSON-LD)** — Organization, WebSite, Dataset, ItemList, Place, and BreadcrumbList for homepage, facility pages, and collection pages.
- **Facility engagement hubs** — rewritten titles and descriptions for search CTR, shareable links, and print-friendly pages.
- **Location fields** — `location.street` and `location.postalCode` for precise geocoding.
- **Error handling** — 404 boundaries, error boundaries, loading skeletons, and empty states throughout.

### Changed

- **Facility titles** rewritten for search engine optimization and discoverability.
- **ISR revalidation** scoped to per-facility (`facility:{id}`) and per-state (`state:{CODE}`) tags for efficient cache refresh.
- **Robots and sitemap** hardened for crawl efficiency (admin UI and API excluded).

### Fixed

- **Email endpoint hardening** — off-path send timing, per-email send rate cap, and safe logging.
- **Status color accessibility** — cancelled status darkened for improved red-green color-deficiency separation.
- **Animation accessibility** — overlay animations and transitions now respect `prefers-reduced-motion`.
- **Energy layer rendering** — energy utility now renders independently of energy.source.
- **Discovery status updates** — append-only updates preserve sourceIndex references (fixes orphaning on approval).
- **State map** — DC (District of Columbia) added to facility state mapping.

### Security

- **API rate limiting** — per-IP request throttling on public endpoints.
- **Email send throttling** — per-email send cap and confirmation token validation.

### Data

- **Enrichment waves:** capacity (MW), energy utility, energy source, community/opposition status, land acreage, investment figures, street address, AI classification tags.
- **Discovery waves:** OSM building scrape (258 colocation net-new), hyperscaler flagship campus enumeration, county GIS hygiene improvements, 71+ coordinate flips to exact precision.
- **Facility count:** 327 → 722 facilities across all states.

## [1.0.0] - 2026-07-15

### Added

- Initial public release.
- Interactive map (MapLibre GL) with globe projection and satellite/street basemaps.
- Facility table with sorting, filtering, and search.
- Data model and Zod schema validation.
- Drizzle ORM and Neon Postgres backend.
- Admin UI for submissions, approvals, and activity audit log.
- Public `/api` endpoints (read-only) and admin-only write endpoints.
- Contribution workflow: staged submissions, human review, and approval gate.
- Discovery pipeline (scheduled, local).
- Accessibility (WCAG 2.2 AA): focus states, keyboard navigation, semantic HTML.
- Dual license: MIT (code) and CC BY 4.0 (data).
