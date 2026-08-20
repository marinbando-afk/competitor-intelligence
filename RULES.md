# WatchBack Reporting Rules — the master file

**This file is the contract for everything WatchBack reports** — app reads, Slack briefs,
weekly reports. Marin reviews and edits *this file*; code and prompts implement it.

**The process rule that keeps quality from decaying** (established 12 Aug 2026, after the
quality plateau post-mortem):

> Every founder correction becomes FIVE things in the same commit:
> 1. a rule in this file,
> 2. a regression test (`backend/test/`, runs on every push via GitHub Actions),
> 3. an enforcement: a deterministic gate/scrubber if mechanically checkable
>    (`backend/src/rulecheck.js`, `claims.js`, `adsguard.js`), or a prompt rule + the
>    nightly QA judge (`backend/src/qa.js`) if it needs judgment,
> 4. **a CLASS SWEEP** (added 20 Aug, after the founder tallied ~40 asks across ~10
>    themes): name the failure CLASS, then fix and test it on EVERY surface and channel
>    where the same derivation exists — the ❗-mark bug was fixed on Website while
>    Ads/Social/Email kept the same disease; congruence was fixed for reads while the
>    compare panel kept its own derivation. An instance fix that leaves siblings is the
>    reason the founder asked the same question five times,
> 5. **REAL-SURFACE verification**: a delivery/rendering change is verified against the
>    actual destination (the founder's Slack via slack-test, the live app), never only a
>    preview or rebuilt text — the 18 Aug Block Kit layout was approved from a preview
>    and never once rendered in real Slack.
>
> A correction that only lands in a prompt is NOT a fix — prompt-only rules decay.
> A failure that degrades SILENTLY is not handled — every downgrade anywhere in the
> pipeline (claim strips, sense-check removals, gate fallbacks, Block Kit rejections,
> scrape failures) lands in the qalog/warm ledgers and reaches the founder's daily 🧯
> digest (qalog.js, 20 Aug). The founder must never again be the monitoring system.

Classes: **ENFORCED** = deterministic code · **PROMPT** = AI-prompt instruction only ·
**BOTH** = prompt rule with a code backstop. Every PROMPT-only rule is a candidate for
promotion to BOTH.

Enforcement spine (in delivery order):
`findings.js` decides what is TRUE → `insights.js` prompts phrase it → `claims.js` strips
unsupported claims before storage → sense-check judge reviews each read → `slack.js` +
`rulecheck.js` gate every delivered line (violations → deterministic fallback + QA ping)
→ `qa.js` self-audit re-checks the delivered brief against computed facts and pings
misses to the founder's Slack.

---

## Thresholds — every magic number in one place (19 Aug audit)

| Number | What it governs | Where |
|---|---|---|
| 23:00 | authoritative nightly capture; 08:00 brief reads it | refresh.js R-DAYLOCK |
| 2 days | a sale banner counts as genuinely NEW (older → "already running") | signals.js R-SALE-NEW |
| 6 days | a sale RENAME stays news, then reverts to unchanged | findings.js R-SALE-RENAME |
| 7 days | a launched ad counts as new ("new" means this week); bare "no new X" allowed only after 7+ quiet days | findings.js / claims.js |
| 3 days | Tier-2 "new ad" Meta start-date window | signals.js |
| 3 ads | first-seen landing PATH becomes a NEW FUNNEL | findings.js R-FUNNEL-PATH |
| 14 days | never-announced funnel still fires once (catch-up window) | findings.js R-FUNNEL-CATCHUP |
| 14 days | "new ad angle" = not run within this window (max 2/brand) | signals.js |
| 3 mornings | persistent alert repeat cap, then 30-day mute, then one reminder | findings.js R-REPEAT |
| 5 days | launch-quiet days before the longest-running ad may surface | findings.js R-ADS-LEADING |
| 30 days | leading-ad cadence (at most once per) | findings.js R-ADS-LEADING |
| 2 days | a stored read older than this is stale — never quoted as fresh; website "last captured N days ago" row appears past it | slack.js |
| 45 days | an occasion is STALE only when farther than this in both directions | occasions.js |
| 180 / 280 chars | brief row clip target / whole-first-sentence hard ceiling | slack.js clipSent |

The asymmetries are deliberate: a sale is "new" for 2 days because banners are noisy and
rotation-prone; a funnel catch-up gets 14 because a funnel is a durable strategic asset,
not a slide. Changing any number = a founder decision recorded here.

## Data boundary — the reporting day

- [snapshots.js + refresh.js R-DAYLOCK] [ENFORCED] **One authoritative capture per brand per day, taken NIGHTLY at 23:00 — each snapshot holds a complete calendar day, and the 08:00 brief reads last night's capture** ("we need a full day to end, otherwise there is always a gap from the moment you reported until the day finished" — founder 12 Aug; nightly-vs-morning re-confirmed by founder in the 19 Aug audit). WatchBack never reports partial-today data
- [snapshots.js R-DAYLOCK] [ENFORCED] A capture-channel day row that already holds real data is IMMUTABLE until tomorrow — admin refreshes, brief re-runs, chat questions and view-time re-checks recompute from stored data, never re-scrape into today. Exceptions: (1) a FAILED capture (empty) may be completed later — filling a hole is repair, not a boundary shift; (2) R-DAYLOCK-NIGHTLY: the forced 23:00 run is the day's authority and may overwrite a same-day deploy-warm row, but only with data that is itself substantive — an errored nightly scrape never clobbers a good earlier row (19 Aug audit: without this exception, on every deploy day the day-lock silently froze the snapshot at deploy time and "complete day" was false). Insight/read/weekly channels are never locked
- [slack.js] [ENFORCED] Re-running the daily brief at any hour produces the identical comparison and identical content — the pair cannot shift intra-day

## Retractions

- [retract.js R-RETRACT] [ENFORCED] Provably-misattributed content is RETRACTED from stored captures — it does not live on as "history" while the app renders it and reads/FOR-YOU tips quote it. A retraction is a data correction, exempt from R-DAYLOCK (which stops partial-today data, never preserves known-wrong data); each is declared with evidence in retract.js, applied once (marker state), logged, scrubs TAINTED READS as well as captures (the generator merges a previous channel read back when the new one is empty — the ghost outlives its ad otherwise), and ends with an insights regeneration (founder, 14 Aug — the Liliana × Argentine-Bonafide ad)

## Congruence — one story on every surface

- [qa.js R-SYNC-01/02/03] [ENFORCED] **The app dossier, the Slack brief and the admin roll-up must be congruent** — all derive from the same day-locked snapshots, so any disagreement is a pipeline bug, flagged by the daily audit, never rationalised (founder, 12 Aug)
- [qa.js R-SYNC-01] [ENFORCED] The app shows a channel read (or captured posts) but the brief block lacks that row → audit ping
- [qa.js R-SYNC-02] [ENFORCED] The brief carries a row for a channel the app shows no read or capture for → audit ping
- [qa.js R-SYNC-03] [ENFORCED] A sale signal fired but the app's website read doesn't mention the sale → audit ping (the app-side twin of R-MISS-01)
- [qa.js R-SYNC-04] [ENFORCED] Newness claims must AGREE across surfaces: the brief saying "New sale live" while the app read says unchanged/already running is a contradiction → audit ping (Bare Bones, 13 Aug)
- [qa.js R-SYNC-05] [ENFORCED] A promo/sale ANNOUNCED in the brief must exist in the app's website read — "Storefront promo: …" in Slack while the app says "Storefront unchanged" is a surface split → audit ping (CurrentBody Grazia, 19 Aug)
- [qa.js] [ENFORCED] The full audit (miss-checks R-MISS-00..06, hard rulecheck, congruence R-SYNC-01..05, model judge) runs automatically after every real daily delivery; findings arrive as 🧯 messages in the founder's Slack (delivery route fixed 19 Aug: pings fall back to the admin account's connected webhook when SLACK_WEBHOOK_URL is unset — they were silently dropped before)

## Repetition cap

- [findings.js R-REPEAT] [ENFORCED] **A persistent alert is reported at most 3 mornings in a row, then goes quiet for 30 days, then reappears once as a reminder and the cycle restarts** ("don't report the same thing more than 3 times in a row" — founder, 18 Aug; the try-derm.com redirect line). Applies at the FINDINGS level (app and Slack mute together) to persistent-alert keys (landing redirects, dead landings — new alert classes must join REPEAT_CAPPED). Daily heartbeat lines the founder explicitly wants every day (live sale, storefront unchanged, ad footprint) are exempt by design; state in _findstate, same-day reruns idempotent

## Fallback substance

- [slack.js R-FALLBACK-SUBSTANCE + rulecheck.js R-PHRASE-03] [ENFORCED] **"Details in the app" is banned; fallbacks quote the substance we already hold** — the post's hook, the newest ad's opening line, the email subject. Quoted teasers pass through safeQuote (URLs, ISO dates and quote characters stripped) so a hostile hook can never make the substance fallback violate the gate and collapse into the generic stub. The WEBSITE row has its own substance tier: sale signal → storefront diff → honest 'Storefront unchanged' line (only when the capture pair was comparable) — the generic stub is a last resort on every channel (Froya, 18 Aug) (founder, 14 Aug; re-applied 18 Aug after a merge clobbered the builders — Bare Bones' "New activity captured" stub; now pinned by tests)

## Ads

- [insights.js GUIDE.ads] [PROMPT] New ad launches LEAD the ads read: how many, formats, hook/angle of each with Meta start dates — never compress launches into a bare count (founder, 7 Aug)
- [insights.js GUIDE.ads] [PROMPT] No launches → open with one clause saying so, then still state the standing core message of the live ads, framed as standing state ("still leading with"), never as news
- [insights.js + adsguard.js + claims.js + rulecheck.js R-ADS-01] [BOTH] NEVER state a total or number of active ads or capture volumes — incomplete sample; describe prevalence qualitatively. Launch counts ("6 new ads launched") ARE news and allowed (founder, ~3×)
- [adsguard.js] [ENFORCED] Delta counts ("3 new ads this week") are left intact by the count scrubber; only totals are stripped
- [insights.js] [ENFORCED] The model is never even shown a total ad count — order conveys prevalence, qualitative share words replace counts
- [insights.js + rulecheck.js R-PHRASE-02] [BOTH] Page attribution taxonomy, EXACT terms only: BRANDED (brand's own page), PARTNERSHIP ("X with Brand" pairing), WHITELISTING (third-party page, no pairing). Never a vague "third-party page" (founder, 21 Jul)
- [insights.js] [ENFORCED] Partnership = an actual Meta pairing, not the brand's name in a byline field
- [insights.js + app.html R-HANDLE-CREATOR] [BOTH] **A PERSON's page with a founder/creator role word is a FOUNDER-HANDLE (whitelisting) page even when the brand name appears in it** — "Mihael Sanko Founder of Ancestral Cosmetics" is the brand advertising through a personal identity, never a plain brand page; the read must NEVER claim "no whitelisting pages" while one is active, and the app chips it 👤 with its own filter (founder, 19 Aug — Ancestral)
- [app.html] [ENFORCED] When more than one Facebook page runs ads, EVERY page gets a clickable filter chip — own-brand pages included; a handle you can see but can't filter by is a dead end (founder, 19 Aug — Ancestral)
- [findings.js R-FUNNEL-PATH] [ENFORCED] **A first-seen landing PATH backed by 3+ ads is a NEW FUNNEL even on the brand's own domain** — Ancestral's /pages/we-made-face-cream-from-beef-fat advertorial went 0→16 ads in one day and the domain-level newDomain check saw nothing; typed new, named with its handles, no ad counts in prose (founder, 19 Aug)
- [findings.js R-FUNNEL-CATCHUP] [ENFORCED] **Captured is NOT announced, funnels edition (same doctrine as R-SALE-NEW): a funnel path first captured within the last 14 days that never went through an announcement fires ONCE as "Ad funnel live (already running) … began on <date>"** — without it, anything that launched before the check existed (or on a day the brief missed) would never be reported. Announce-once state in _findstate.funnelsAnnounced, consumed ONLY by the committed daily read generation — views/previews/API rebuilds never consume it (same "previews must not consume the once-only state" rule as sales); requires proof of absence (an older ads capture without the path), and older paths are established scenery, not missed news (founder, 19 Aug — "what about ancestral and not reporting the new funnel?")
- [findings.js + insights.js + signals.js + slack.js + qa.js R-FUNNEL-LEAD] [BOTH] **A new funnel gets the biggest priority when reporting insights — visible in the collapsed summary line and always called out in Slack** (founder, 19 Aug). Five layers: (1) new-funnel findings LEAD the ads findings list (order conveys priority to the model); (2) the deterministic launch line itself names it ("… → the NEW funnel <path>", ships verbatim on every surface, visible before expanding); (3) GUIDE.ads makes the funnel the summary's opening, above launches, never a bullet; (4) path funnels join s.funnel → 💡 badge + ❗ mark (textClaimsFunnel follows the sentence); (5) R-MISS-06 audit ping when a computed funnel never reaches the brief block
- [insights.js GUIDE.ads] [PROMPT] FUNNEL FACTS are ground truth — never claim no third-party pages/off-domain landings unless facts confirm; surface any partnership/whitelisting/advertorial funnel as a notable tactic
- [insights.js GUIDE.ads] [PROMPT] Mention each Facebook page ONCE — chips already list them; name a page only when the page IS the news, refer to the rest collectively
- [insights.js GUIDE.ads] [PROMPT] Page drops are news: a partnership/whitelisted page with ads yesterday and none today gets an explicit retirement call-out — but only per the proof rule below
- [ads.js] [ENFORCED] "Facebook page retired" needs proof (non-capped capture + window past the page's newest ad, or a direct page probe with zero ads); no proof → silent (founder, 21 Jul / 29 Jul)
- [adsguard.js + claims.js] [BOTH] ABSENCE RULE: never say a page/creator/tactic "dropped/went quiet/stopped/was retired" because it's missing from today's capture; at most "not seen in today's capture". A retirement claim is allowed ONLY with the proof the rule above requires (founder, 2 Aug)
- [adsguard.js + claims.js] [BOTH] A thin capture (<50% of typical) may never support a switch/shift/pivot claim (Casa and Beyond, 4 Aug)
- [adsguard.js + claims.js] [BOTH] If every earlier capture was empty, nothing today may be called new/first/changed (Bonafide, 4 Aug)
- [adsguard.js + claims.js] [BOTH] Entities seen in earlier captures may never be described as new/first/just added (founder, 6 Aug)
- [findings.js] [ENFORCED] "New ad" requires BOTH: id never seen before AND Meta start date within 7 days ("new" means this week)
- [findings.js] [ENFORCED] Launch findings carry the Meta-reported start date, format, Facebook page, opening hook quote, landing domain — **the words "(Meta start date)" are PROVENANCE and never reader-visible**: prose says "launched 2026-08-19", the source of the date lives in evidence; R-META-01 gates the phrase on every surface, and a row opening with a beheaded quote fragment ('This…" → domain.') is gated as a truncation corpse (founder, 20 Aug — Smooche: "what does mean Meta start date")
- [findings.js R-ADS-LEADING] [ENFORCED] **"Leading ad" = the LONGEST CONTINUOUSLY-RUNNING ad by Meta's own start date, surfaced only when the brand has launched NOTHING for 5+ days, and at most once per 30 days** (founder cadence decision, 19 Aug audit — the original 12 Aug rule was marked ENFORCED but had never been built; rediscovered as a phantom and implemented per the new spec). Computed over the FULL capture in code, monthly cadence in _findstate.leadingAt, commit-gated like every announce-once state
- [findings.js + rulecheck.js R-ADS-PERF] [ENFORCED] Meta publishes impressions and spend ONLY for political/issue ads — never for commercial ads. "Top performing", "most impressions", "highest spend" are unknowable and now a GATE violation on every surface; say "their longest-running ad" (founder, 12 Aug; gate added 19 Aug)
- [findings.js R-ADS-FOOTPRINT] [ENFORCED] Where the ads run TO and FROM is ONE sentence, never two: "Recent ads run to shop.mikmak.ai and from \"Pacific Foods\" handle." Two findings on the same subject ship as two consecutive sentences whenever the claim gate falls back, and read as a stutter (founder, 12 Aug)
- [findings.js R-ADS-RECENT] [ENFORCED] The ad footprint reads "Recent ads run to X and from Y handle" — never "Every captured ad", which leans on a capture size the client doesn't know or remember (founder, 13 Aug — Luxe)
- [ALL SURFACES] [PROMPT] **No sentence may restate the subject of the one before it.** If two consecutive sentences describe the same set of ads/posts/products, they are one sentence. Applies to every generated line, not only the ads read (founder, 12 Aug: "polish the other messages if and when needed")
- [findings.js + rulecheck.js R-LAUNCH-WINDOW] [ENFORCED] **The brief's launch line is a ONE-DAY window, always in human words** — "N new ads launched today / since yesterday", exactly the Casa & Beyond format. Older never-before-captured stragglers (capped windows surface them late) keep their per-ad findings in the app but never inflate the daily count or stretch the window into ISO dates ("21 new ads launched since 2026-08-13" — an insight format the founder never asked for; Nolan, 15 Aug). "launched since <ISO>" is a gate violation
- [findings.js] [ENFORCED] Launch batch line: human dates ("today"/"since yesterday"), "all video"/"all image" for a uniform mix of 2+, just "video"/"image" for a single ad ("all" of one is nonsense), no bookkeeping parentheticals, no itemisation suffix (founder, 12 Aug ×2)
- [findings.js] [ENFORCED] Launch batch line carries creative substance — newest hook quoted (word-boundary clip, inner quotes normalised) + destination (founder, 9 & 12 Aug)
- [insights.js] [ENFORCED] Guaranteed hook: if a gated ads summary has no quoted hook, the newest hook is appended deterministically (founder, 11 Aug)
- [insights.js GUIDE.ads] [PROMPT] Dominant-hook template: quoted hook — angle in plain marketing terms — destination — tactic named (founder-praised, 9 Aug)
- [insights.js GUIDE.ads] [PROMPT] Unchanged days: never stop at "unchanged" — say what the ad IS (hook, format, destination)
- [insights.js GUIDE.ads] [PROMPT] Always "Facebook page" or "landing page" — never a bare "page"
- [findings.js ads.pages] [ENFORCED] Quoted page names are labelled as what they are: `…run from "Seranova", "Daily Discounts Online" handles.` — the word "handle"/"handles" is appended (founder, 12 Aug)
- [insights.js + rulecheck.js R-PHRASE-01] [BOTH] Page-like campaigns: exactly "optimised for Facebook page likes" / "optimised for Instagram follows" — never "sends traffic to Facebook's login page" (founder, 22 Jul)
- [insights.js] [BOTH] Landing-page format comes from the fetched-and-read page, never inferred from the URL/subdomain; unread pages are said to be unread
- [insights.js GUIDE.ads] [PROMPT] Marketplace destinations are a deliberate channel strategy — never "not driving sales" or a DTC shortfall
- [insights.js] [BOTH] International storefront domains among landings = buying ads into those countries; lead-worthy expansion intel (founder, 22 Jul)
- [insights.js GUIDE.ads] [PROMPT] Offers seen in ads live IN THE ADS ("an ad runs X") — never the brand's current/site-wide sale
- [findings.js + claims.js] [BOTH] The capture is not a census — no universal quantifiers ("all ads", "only", "every page") unless the sentence names the sample
- [insights.js + claims.js] [BOTH] Express absence/duration with dates ("since monitoring began on 18 Jul"), never a number of captures (founder, 25 Jul)
- [insights.js] [ENFORCED] Engagement shown for latest capture only — the model cannot subtract captures and miscall a "drop"
- [ads.js] [ENFORCED] Inactive ads never reported as current; ads going inactive keep an honest INACTIVE badge on older days (founder, 24 Jul)
- [ads.js] [ENFORCED] Newest first — every "first N" surface shows the newest launches (founder, 29 Jul)
- [ads.js] [ENFORCED] Every launched ad counts — no dedup of launch batches (founder, 20 Jul)
- [ads.js] [ENFORCED] Precision-first attribution: never show a random business's ads; name-twin advertisers with different domains are DIFFERENT; unsure → skip (founder, 24 Jul)
- [ads.js R-PAIR-JUDGE] [ENFORCED] **The product is the disambiguator** — "it's not a high-risk name if they sell bone broth." An advertiser whose ad content clearly doesn't match what the brand's site sells is excluded immediately: the product-sense judge (site descriptor, fail-closed) OUTRANKS every soft attribution door incl. branded-content pairings; only own-domain/own-page/alias landings bypass it (founder, 14 Aug)
- [ads.js R-TWIN-PAIR] [ENFORCED] A brand-name match in a Meta branded-content PAIRING is NOT definitive — name twins exist as partners too. If the ad lands on the advertiser page's own commercial domain, the pairing partner is decoration and the ad belongs to the advertiser; reject (founder, 14 Aug — Liliana Electrodomésticos × Argentine Bonafide sold a milk frother into the US broth brand's report)
- [insights.js] [ENFORCED] Any ad flagged by OFFER TIMING FACTS is pinned into the model's sample so the finding's ad can be identified, not guessed (founder, 24 Jul)
- [signals.js] [ENFORCED] "New ad angle" only when not run in last 14 days; max 2 per brand; brief dedupes variants sharing a hook (founder, 29 Jul)
- [signals.js] [ENFORCED] Tier-2 "new ad" requires Meta start date within 3 days — first appearance in a capture alone is not newness

## Website / Storefront

- [insights.js GUIDE.website] [PROMPT] A SALE = discount/named event/BOGO/GWP/promo code. Free shipping, free returns, new arrivals are OPERATIONAL — never a sale (founder, 17 Jul)
- [occasions.js] [ENFORCED] isSaleBanner encodes the above deterministically
- [occasions.js R-BANNER-VERBATIM + website.js + rulecheck.js R-META-01] [ENFORCED] **A banner data field holds VERBATIM page text, never model commentary** — the CurrentBody reader appended "(This is a press quote, not a promotional offer/sale.)" to its answer, the caveat was stored in the banner, and the word "sale" inside it flipped isSaleBanner: the disclaimer CREATED the promo it denied. cleanBannerText strips meta-parentheticals + orphan quotes at WRITE (website.js) and at every READ (findings/signals/isSaleBanner — history holds poisoned rows), and R-META-01 gates any surviving self-talk out of every surface (founder, 19 Aug — CurrentBody)
- [occasions.js R-BANNER-PRESS] [ENFORCED] **A press/award quote in the announcement bar ("Beauty technology at its finest." — Grazia) is credibility messaging, never a promo** — isPressQuoteBanner forces isSaleBanner false, so it types as context like operational banners and no surface phrases it as "Storefront promo" (founder, 19 Aug — CurrentBody)
- [findings.js R-BANNER-OPS] [ENFORCED] An operational banner (free shipping / returns / new arrivals) is NEVER reader-visible on any surface — the finding is typed context (machinery-only, keeps banner continuity); "don't report free shipping offers" (founder, 13 Aug — Bonafide)
- [insights.js GUIDE.website] [PROMPT] ALWAYS lead with whether a genuine sale is active right now — an ongoing unchanged sale must still be named, by its EXACT occasion name and headline discount
- [insights.js + website.js] [BOTH] NEVER cite a count of discounted products — describe a sale only by occasion + headline discount (founder, 18 Jul)
- [website.js] [ENFORCED] diffWebsite emits only sale STATE transitions; widened/narrowed discounts are churn
- [insights.js GUIDE.website] [PROMPT] Large discounted share with no named sale = likely standing compare-at pricing; say so, never overstate as a fresh sale
- [insights.js + website.js] [BOTH] A NEW PRODUCT LAUNCH is the top website signal — lead with it and NAME the product(s); never just a number; variants collapse to "Name — N variants" (founder, 18 & 22 Jul, 1 Aug)
- [website.js + claims.js] [BOTH] A new LISTING is not a new PRODUCT (-1/-2 handles, shared base names = re-listings); zero-price "FREE gift" SKUs are a promo mechanic; laddered duplicate prices are PRICE TESTING (founder, 1 & 6 Aug)
- [website.js] [ENFORCED] A 0-price placeholder is never a price move (founder, 22 Jul)
- [website.js + findings.js R-PRICE-CONTEXT] [ENFORCED] **A price move carries its meaning, not just the numbers**: every price-change line states the % ("$44 → $39 (-11%)"), and a product's 3rd+ move inside 14 days is named as a pattern ("their 3rd price move on this product inside two weeks") — margin pressure and clearance are the story, computed from stored day rows, never model arithmetic (founder, 19 Aug)
- [website.js R-CURRENCY-01] [ENFORCED] Price-move evidence captions state the numbers in the STORE'S OWN currency and label them "(store currency)" — the paired screenshot may render geo-converted prices (Casa & Beyond: A$119.99 feed vs $96 USD page). Never guess or convert a currency; precision-first (founder, 13 Aug)
- [insights.js + findings.js] [BOTH] ANNOUNCEMENT BARS ROTATE: a slide missing ≠ sale ended; a slide seen ≠ sale started; sale start/end comes ONLY from the ACTIVE SALE facts (founder, 6 Aug)
- [website.js + app.html R-COMPARE-LAYERS] [ENFORCED] **The before/after compare panel is BANNER-AWARE**: when the announcement bar changed (meaning-based identity, rotation-safe) but the product feed didn't, the panel says BOTH layers — "Announcement bar changed — new sale banner. Now: '…' (was: '…'). The product feed itself is unchanged…" — never a bare "No changes" directly beneath an announced new sale (founder, 20 Aug — Grüns' Birthday banner over "No changes since the last capture"; the UKLASH contradiction class, banner layer)
- [insights.js] [ENFORCED] SALE TIMELINE dates computed in code, quoted verbatim — never model arithmetic (founder, 24 Jul)
- [insights.js] [ENFORCED] Baseline day: promo "already running when monitoring began" — never "launched today" (founder, 30 Jul)
- [insights.js R-BASELINE] [PROMPT] **A new competitor's FIRST report is the standing-state dossier, not a caveat litany**: the live sale (as already-running), the core ad message and funnel map, the banner, the latest email and post — framed once as "monitoring begins — this is where they stand today". The no-earlier-capture limits still bind every claim; they just don't get to BE the story (founder, 19 Aug)
- [insights.js + claims.js + rulecheck.js R-DATE-02] [BOTH] Already-running promo: ACTIVE and unchanged; no start date, no "live/running since", no day counts; wording variance of the same banner (rephrasing, partial reads) is never a new sale (founder, 9 Aug) — but an OCCASION change is, see R-SALE-RENAME
- [findings.js R-SALE-RENAME] [ENFORCED] **A RENAMED SALE IS A NEW SALE.** A change of OCCASION ("Summer Sale" → "Back to School Sale") is a new sale even when the headline discount is identical — the occasion IS the sale. Report it as a new sale, name what it replaced and when that was last captured, and add that the economics are unchanged. Never "renamed, not new"; never "active and unchanged" (Seranova, 12 Aug)
- [findings.js R-SALE-RENAME] [ENFORCED] A rename is dated to the capture that first SAW the new wording, never to a publish date we cannot know — say so explicitly ("we know when we first saw it")
- [findings.js R-SALE-RENAME] [ENFORCED] A rename is news for 6 days, then reverts to unchanged — a client reading Wednesday's brief has not necessarily read Tuesday's
- [findings.js R-SALE-RENAME] [ENFORCED] Rename/replacement requires a clean split at the WORDING level: exactly two wordings, the older one held the bar for a run of ≥2 days, no reappearance after the swap, neither text a substring of the other, identical discount figures. A ROTATING bar and a PARTIAL vision read can never produce a rename (Glov 6 Aug / Frøya 27 Jul)
- [findings.js] [ENFORCED] Countdown values stripped from banner quotes; a timer recurring across days = "evergreen urgency, not a real deadline" (founder, 10 Aug)
- [insights.js] [ENFORCED] "Checked, no sale" is a finding — never "no website data available" (founder, 27 Jul)
- [insights.js] [BOTH] Typical price range = 10th–90th percentile; $0/joke/PR listings are stunts, never the range
- [insights.js] [ENFORCED] Same-day pair or missing feed on either side → no price/product/sale change may be reported (29 Jul)
- [insights.js] [ENFORCED] Products in ANY earlier capture can never be "new" (founder, 6 Aug)
- [website.js] [BOTH] Banner reader reports only what is visible; named occasions kept exactly; non-answers coerced to empty; read from the rendered screenshot, not raw HTML
- [website.js] [ENFORCED] Change-gated screenshots; quiet days labelled "unchanged since <day>" (founder, 20 Jul)
- [app.html] [ENFORCED] The unchanged-day screenshot caption says "showing the last stored frame (<day>)" — never "when it last changed": a stored frame can come from banner-rotation noise or the weekly heartbeat, so the frame date is not proof of a visible change (Bare Bones, 13 Aug)

## Email

- [insights.js GUIDE.email] [PROMPT] The LATEST email leads (subject, core message, what it pushes) — never open with cadence arithmetic (founder, 10 Aug)
- [findings.js + slack.js + insights.js R-EMAIL-OFFER] [BOTH] **A discount or code inside an email is a first-class signal** — the aggressive retention play, invisible on the storefront. Deterministically flagged in findings ("New email: … — carries a discount offer (list-only pressure, not shown as a site sale)"), carried by the fallback row, and the read is instructed to lead with it — never buried in a cadence bullet (founder, 19 Aug)
- [insights.js] [BOTH] Sender-domain alias = deliberate deliverability firewall — bullet-worthy signal; the alias fact is injected by code
- [insights.js] [ENFORCED] Opt-in confirmation emails are never analysed; honest fixed summary when only a confirmation exists
- [insights.js] [ENFORCED] Email absence is never evidence (suppression/scroll-out) — canJudgeAbsence hard-false
- [signals.js] [ENFORCED] Email counts ARE safe to state (verifiable); same-day sends collapse into one line (founder, 25 Jul)
- [email.js] [BOTH] Alias judge: precision first — better to miss the newsletter than attribute another company's email
- [email.js] [ENFORCED] Previews decoded from quoted-printable, invisibles stripped, at store AND read time; all-padding previews rebuild from html (founder, 12 Aug) — rulecheck R-TEXT-01 backstops delivery
- [weekly.js] [ENFORCED] Weekly email counts use the same alias resolver as daily — surfaces can never disagree

## Social

- [insights.js GUIDE.social] [PROMPT] Engagement is CUMULATIVE lifetime — never frame lower counts as a drop/slump/algorithm problem; never compute deltas between captures
- [insights.js] [BOTH] Capture window holds newest N posts — a post out of view was pushed out, never "removed/deleted/replaced" (2 Aug)
- [insights.js] [PROMPT] Platform vocabulary: Reels are IG/FB; TikTok has videos; YouTube has videos/Shorts (founder, 5 Aug)
- [insights.js] [PROMPT] Name the creator exactly as captured, or "a creator post" — never guess (founder, 2 Aug)
- [claims.js] [ENFORCED] "No new posts" requires a connected account (5 Aug)
- [signals.js] [ENFORCED] New-post detection skips empty/failed prior scrapes

## Sales / Offers

- [occasions.js] [ENFORCED] An occasion is STALE only when >45 days away in both directions; all date arithmetic in code, handed as ground truth
- [insights.js] [PROMPT] An out-of-season sale is a LEAD finding — name occasion, distance, meaning (discount = the real price anchoring a fake RRP); quote computed numbers verbatim
- [occasions.js + findings.js] [ENFORCED] Identity travels with the finding (page + quote + link); no running-day counters, no "live since" (founder, 24 Jul & 9 Aug)
- [occasions.js + signals.js + insights.js] [BOTH] Never report countdown timers / "Today only" / "Last chance" as findings or call them fake — common ecom practice (founder, 17 Jul). Out-of-season OCCASIONS still lead
- [insights.js GUIDE.ads] [PROMPT] Rotating-pretext discounting = ONE deliberate anchor-pricing tactic, never several stale sales itemised (Seranova case)
- [insights.js] [PROMPT] A live sale is ALWAYS material — name occasion, size, still running; never routine noise
- [insights.js] [PROMPT] The brand's CURRENT sale comes only from their WEBSITE; ad offers are ad-creative content, said as "in an ad" (founder, 20 Jul, ×3)
- [signals.js] [ENFORCED] Stale-offer announced ONCE (fingerprint state; previews never consume it); one line per occasion, merged (founder, 24 Jul)
- [signals.js] [ENFORCED] Slack sale trigger: product-feed transition primary; banner fallback rotation-safe; sale→non-sale slide rotation is never "sale ended" (founder, 17 Jul)
- [signals.js R-SALE-NEW] [ENFORCED] "New" ONLY when the banner genuinely first appeared within the last ~2 days of capture history; an OLDER never-announced sale is reported as `*Sale live (already running)* — “…”` — announcing late never makes an old offer new (Ancestral lip-balm GWP, 13 Aug). A first-ever sale announcement says NEW in the text itself — `*New sale live* — “…”` (bold in Slack, banner quoted verbatim) — so it is 100% clear it was not there before (founder, 12 Aug)
- [signals.js] [ENFORCED] CATCH-UP: captured ≠ announced — a live sale banner never through a DELIVERED brief fires once (_salestate) (founder, 12 Aug — Seranova Back-to-School)
- [slack.js R-ONE-SOURCE] [ENFORCED] **SINGLE SOURCE (supersedes R-SALE-LEADS, 12 Aug):** every Slack row quotes the app's stored read VERBATIM; deterministic signal text only fills an ABSENT read, never replaces a present one — congruence by construction, not by checking (founder, 13 Aug — Froya: Slack said "New sale live" while the app said "sale unchanged"). The ❗ mark and 💡 badge still flag sale days; if the app read fails to name a fired sale, R-SYNC-03/R-MISS-01 ping the founder rather than Slack inventing its own text
- [qa.js R-MISS-01..03] [ENFORCED] Self-audit: a computed sale / new-product / stale-offer signal missing from the delivered brief pings the founder (12 Aug)
- [occasions.js] [ENFORCED] One meaning-based "same banner" definition shared by all surfaces
- [signals.js R-SALE-ID] [ENFORCED] Sale announce-state identity survives daily text variance: countdown values are stripped before fingerprinting (Casa's timer changed the string every day) and announced banners are matched with the meaning-based sameBannerText (UKLASH's offer is read differently day to day) — otherwise the catch-up re-fires ❗ forever on unchanged sales (founder, 14 Aug)

## Dates & Language

- [insights.js + occasions.js] [ENFORCED] The model is always told today's date
- [insights.js + claims.js + rulecheck.js R-DATE-02] [BOTH] Time-anchor every state as NEW or UNCHANGED; never "live/running since <date>", never durations
- [insights.js + slack.js] [BOTH] "Today" is written bare; delivery re-anchors to the reader's clock ("today"→"yesterday"); genuine earlier dates stay dates (founder, 10 Aug)
- [rulecheck.js R-DATE-01] [ENFORCED] Raw ISO dates in the brief ONLY after a bare "launched", "checked on" or "began on" — the blanket "since <date>" exemption let "New email item since 2026-08-11" ship (tightened 13 Aug), and "launched since <ISO>" is itself a violation per R-LAUNCH-WINDOW (tightened 15 Aug); everything else relativized (founder, 12-15 Aug)
- [findings.js windowFindings] [ENFORCED] New email/social findings read "New email: \u201c\u2026\u201d" / "New TikTok post: \u201c\u2026\u201d" — no "item", no date (daily cadence makes "since yesterday" implicit), quotes clipped on word boundaries (founder, 13 Aug — Tallowed Truth, CurrentBody)
- [findings.js + rulecheck.js R-PROV-01] [ENFORCED] NEVER state the comparison window in the brief ("Storefront compared 2026-08-11 → 2026-08-12", any date→date range) — briefs are DAILY, so "vs yesterday" is implicit and stating it only confuses. Change/no-change lines read absolutely ("Storefront unchanged — same prices, products and sale."); provenance dates live in evidence fields, never prose (founder, 12 Aug: "Slack messages are being sent daily!!!")
- [insights.js + claims.js] [BOTH] Never count captures — use dates or "since monitoring began on <date>"
- [insights.js] [PROMPT] Newsroom order: event first, plain words, then interpretation; plain language a marketer uses; split sentences needing semicolon+dash (founder, 22 Jul)
- [slack.js + insights.js + qa.js R-PROSE-01] [BOTH] Reads sound like a proficient reporter, never a broken tool: no tense clashes (the relativizer DROPS "today" inside present-tense clauses instead of swapping in "yesterday"), never the same fact twice in one line ("No change — … unchanged"), no orphan punctuation, varied sentence openings; the nightly judge flags prose artifacts (founder, 13 Aug)
- [insights.js] [PROMPT] Brand-initials pages ("BF USA") are the brand's own page, never whitelisting (founder, 6 Aug)
- [insights.js] [PROMPT] Name the channel inside the sentence, naturally
- [insights.js] [PROMPT] English only; non-English only as verbatim competitor quotes (17 Jul)
- [insights.js + slack.js + rulecheck.js R-TEXT-02/R-QUOTE-01] [ENFORCED] Never cut mid-word/clause; unfinished clauses dropped whole; quotes/parens healed (founder, 12 Aug)
- [claims.js] [ENFORCED] Never invent internal mechanisms ("below our capture threshold") (6 Aug)
- [signals.js] [ENFORCED] Funnel platforms explained in plain words ("MikMak, a 'where to buy' page…") (founder, 22 & 24 Jul)

## Links & URLs

- [adsguard.js + slack.js + rulecheck.js R-URL-01] [ENFORCED] Anything after "?" is tracking noise — stripped everywhere, delivery-backstopped (founder, 10 Aug)
- [ads.js] [ENFORCED] Never hyperlink a dead/unverified page; dead funnels keep the domain fact, lose the link (founder, 23 Jul)
- [findings.js] [ENFORCED] Dead landing (404/410) reported with check date, "Do not link it"; zero-width-space de-linkification (founder, 9 & 10 Aug)
- [findings.js + rulecheck.js R-CLAIM-01] [ENFORCED] Same-brand redirects (incl. hyphen variants) are storefront hops, never retired funnels; redirect findings name the exact probed URL, never "domain X redirects" (founder, 12 Aug)
- [findings.js + claims.js + rulecheck.js R-TEXT-04] [ENFORCED] A caveat lives INSIDE the sentence it qualifies, never as its own sentence — a stripped claim must take its caveat with it. The claims gate drops any survivor opening with "("; the delivery gate rejects lines that lead with a parenthetical ("(One ad URL tested…)" led Seranova's ads row context-free — founder, 13 Aug)
- [rulecheck.js R-TEXT-02] [ENFORCED] Label-only rows ("Latest email.", "New email:") are truncation corpses — the clip landed inside the quote and the balancer removed it; the gate rejects them and the deterministic fallback (carrying the real latest subject) ships instead (founder, 14 Aug — Ancestral)
- [findings.js] [ENFORCED] Landing-health findings (DEAD, redirect) are typed CHANGE, not state — they trace as change findings so the claims gate can never strip the engine's own ground truth (the strip is what orphaned the Seranova caveat)
- [insights.js] [BOTH] Cite funnels by FULL working URL; PAGE NOT LOADING pages named plainly, never linked
- [ads.js] [ENFORCED] App deep-links/shorteners/social redirects never surfaced as funnels
- [signals.js] [ENFORCED] Long ad URLs linked behind "view ad ↗" labels

## Slack brief composition

The agreed layout (founder, 12 Aug "format it somehow so it's readable and not a pile
of text"; refined 18-19 Aug: Block Kit, bold colon labels, ❗ after the label, variant-C
gap). One block per brand, one row per channel, real dividers between brands:

```
🛰️ WatchBack daily · Wed 19 Aug        (small context caption)
──────────────────────────────         (Block Kit divider)
*Nolan Interior* 💡
*Ads:* ❗ Six new videos launched yesterday on the Miracle Sofa Cover — spec,
objection and budget angles at once.
*Social:* New Instagram post doubles down on washable covers with a 'mess
happens' spill-life hook.

*Website:* Back to School Sale — up to 50% off — active and unchanged.
*Email:* ❗ Latest: "Your $10 off expires soon" — a $10-off push via expiry reminder.
──────────────────────────────
*Casa & Beyond* ✅ no new moves
*Ads:* Standing message: cozy-home value kits, all branded video.

*Website:* 50% off Clearance Sale active — with a countdown timer that resets daily.
──────────────────────────────
🔗 View the full dashboard & signals →   (context caption)
```

- [server.js + app.html R-WEBHOOK-PROBE] [ENFORCED] **Webhook capability is verified at CONNECT time, never assumed**: the connect ping is sent as Block Kit; a rejection marks the webhook as legacy and says so in the channel message AND the connect UI ("briefs will arrive as structured plain text — a Slack-app webhook enables the full layout"). A rendering feature may never silently depend on the destination's type again (founder, 20 Aug — the 18 Aug layout never rendered on the legacy webhook and nothing said so)
- [slack.js briefBlocks + renderPlainBrief] [ENFORCED] The brief renders as Slack Block Kit: one section per brand, a real divider between brands, header/footer as small context captions; the plain-text brief stays CANONICAL (the QA audit reads it). A Block Kit rejection (legacy incoming-webhooks can refuse blocks) redelivers as the RENDERED plain variant — divider lines between brands + the variant-C gap carried in text — and the rejection is LOGGED, never silent (founder, 18-20 Aug: the layout may never have rendered on the legacy webhook and the silent fallback hid it; notification fallback is the header line, not the full brief)
- [slack.js] [ENFORCED] Channel labels are BOLD with a colon ("*Ads:*"), and ❗ sits AFTER the label so labels form one aligned scannable column (founder, 18 Aug — supersedes the 12 Aug left-gutter ❗ position)
- [slack.js briefBlocks] [ENFORCED] VARIANT C spacing: ONE blank row between the SAYING group (Ads·Social) and the DOING group (Website·Email) inside each brand block — render-time only, never in the canonical text (founder-approved from preview, 19 Aug — supersedes the 12 Aug blank-line-between-every-row)
- [slack.js] [ENFORCED] Channel lines clip at 180 chars, at a sentence boundary — one strong sentence per channel, the full read lives in the app (founder, 18 Aug; exception 19 Aug: an oversize FIRST sentence ships whole, see clipSent rule below — the clip may never amputate the news)
- [slack.js R-BRIEF-FORMAT] [ENFORCED] NO decorative emoji: no channel glyphs (📣📱🛒✉️) — the labels already say it (founder, 12 Aug). SUPERSEDED PARTS: the status badges 💡/🔹/✅ were re-admitted as FUNCTIONAL markers (R-EMOJI-01, 13 Aug), and ❗ moved from the left gutter to AFTER the label (18 Aug) — this entry's original "only emoji, left gutter" wording no longer applies
- [slack.js R-BRIEF-FORMAT] [ENFORCED] EVERY subscribed channel gets its OWN ROW, every day — never collapsed into a shared "quiet" line. A brand is a predictable block of rows, so the reader's eye finds Social in the same place every morning (founder, 12 Aug)
- ~~Rows sort NEWS FIRST within each brand~~ **SUPERSEDED (19 Aug audit):** rows ship in FIXED order — Ads · Social · Website · Email — which is what the predictable-block rule above requires and what the founder-approved variant-C layout (Ads·Social / Website·Email groups) assumes; ❗ after the label keeps news scannable without reordering
- [slack.js R-BRIEF-FORMAT] [ENFORCED] Each row opens with ONE clause before its detail (blank-line-between-every-row superseded 19 Aug by the variant-C group gap above)
- [slack.js R-BRIEF-FORMAT] [ENFORCED] A QUIET row keeps the SIMPLE format but ALWAYS names the latest item that still stands: `No new posts — latest is still "…"` / `No new emails — latest: "…"` / the standing sale or core ad message (founder, 19 Aug audit — supersedes the 12 Aug "quiet-since date" format: "keep the simple rows but always mention the latest")
- [slack.js R-NOT-CHECKED] [ENFORCED] Three states, never two: news · checked-and-quiet · NOT CAPTURED, said plainly, never dressed as quiet (a missing row reads as "the competitor is quiet" — a false claim; Pannonian Padel, 5 Aug; implemented 19 Aug audit). Current coverage: Website "Last captured N days ago — capture is retrying" when the newest usable capture is >2 days old; Social "Nothing captured from the tracked profiles in the last scan" when handles are connected but the scan returned nothing; a comparable website capture with no read/sale still gets its honest "Storefront unchanged" row. Ads/email variants pending a reliable captured-vs-empty discriminator
- [slack.js R-BRIEF-FORMAT] [ENFORCED] A brand with nothing anywhere still gets its rows — silence must never look like a failure

- [slack.js] [ENFORCED] SYNC RULE: brand blocks mirror the app's per-channel summaries; the brief can never contradict the app (founder, 10 Aug — the intent; the MECHANISM is R-ONE-SOURCE for text and R-MARK-TEXT for the ❗/badge, which supersede this entry's "❗ marks new signals" derivation)
- [slack.js R-MARK-SYNC] [ENFORCED] The ❗ must agree with the sentence it decorates: a row asserting launches ("N new ads launched") always carries the new-signal mark, even when the signals engine missed it — marks follow words, never a second derivation (founder, 14 Aug — Ancestral)
- [slack.js R-MARK-TEXT] [ENFORCED] **R-MARK-SYNC in BOTH directions for the Website row: the ❗ derives from the shipped sentence itself (textClaimsWebNews), never from the signal engine** — s.sale stays truthy on every standing-sale day (catch-up refires, wording drift) and decorated "Summer Sale unchanged — prices steady" as news; an "unchanged" row can never carry ❗ (founder, 19 Aug — Glov: "why an exclamation mark if nothing happened")
- [slack.js R-MARK-TEXT] [ENFORCED] **Mark-follows-text on ALL FOUR rows (completed 19 Aug audit):** the Ads/Social/Email ❗ now derive from the shipped sentence too (textClaimsAdsNews/SocialNews/EmailNews, quiet-phrase-stripped) — the signal-engine marks were the same asymmetry that produced Glov's ❗-on-unchanged
- [slack.js + insights.js + qa.js R-CAMPAIGN] [BOTH] **Cross-channel campaign synthesis: when 2+ channels move on the SAME theme within ~2 days, one "Campaign:" line LEADS the brand block** ("Coordinated push on the tallow balm: new advertorial funnel, fresh ad batch and a 15%-off email inside 48h") — the connection is the intelligence. Generated in the brief (empty string when no genuine connection — NEVER manufactured), gated by the strictest claims facts, delivery-checked by rulecheck (violations drop the line, no fallback), and the QA judge flags any campaign line supported by fewer than two rows in the block (founder, 19 Aug)
- [slack.js R-NAME-01] [ENFORCED] **One canonical display name per host on every surface** — reads are generated with the tracked-list name, so brief headers resolve through it too; "Current Body" over "CurrentBody" reads as two different brands (19 Aug audit)
- [slack.js badgeFor R-MARK-TEXT] [ENFORCED] **The brand badge must agree with the rows it crowns** — "✅ no new moves" shipped one line above an ❗ funnel row (Ancestral, 19 Aug) because the badge came from the signal engine while the row came from the read. ❗ + a priority claim (funnel/new sale/new product) → 💡; any ❗ or activity → 🔹; ✅ only when every row is quiet
- [slack.js clipSent + rulecheck.js R-TEXT-02] [ENFORCED] **The 180-char row clip may never amputate the news**: an oversize FIRST sentence ships whole (hard ceiling 280) — the funnel callout was clipped to "…running from the." (Ancestral, 19 Aug); clip fallbacks strip dangling articles before the ellipsis, and R-TEXT-02 now fires on any line ending in an article/conjunction. The clip is QUOTE-AWARE: a sentence boundary INSIDE an open quotation is never a cut point — extend through the closing quote (≤280) or retreat to the previous clean boundary (AG1, 20 Aug: the hook contained ". ", the clip landed mid-quote, R-QUOTE-01 rejected the line and a rich read shipped as the stub)
- [slack.js R-BASELINE-BRIEF] [ENFORCED] **A brand's first days never ship as bare "✅ no new moves"** (Bloom/Gruns, 20 Aug — a false claim: no comparison exists yet). Captured-but-baseline → "🔹 baseline forming" with the standing state (storefront banner quoted, first-capture note); nothing captured yet → "First capture runs tonight — the baseline report lands tomorrow morning." The website row also quotes the captured banner on baseline days when the read gated to empty
- [slack.js] [ENFORCED] **Ads fallback tier 2**: no NEW-ad activity ≠ no ads — when the read is gate-rejected and there are no fresh launches, the row ships the newest running ad's hook ("Newest ad still running opens: …"), claiming no newness; the stub is a last resort only when the brand has never had an ad captured (AG1, 20 Aug)
- [slack.js + rulecheck.js R-FALLBACK-SUBSTANCE / R-PHRASE-03] [ENFORCED] **"Details in the app" is banned on every surface** — captured items carry their own hook/subject/about, so deterministic fallbacks quote them: `New Instagram post: "Play your comfort card…"`, `2 new ads captured — newest: "…"`. Deflecting to another surface instead of stating substance we already hold is lazy reporting; the gate rejects the phrase outright (founder, 14 Aug)
- [slack.js R-CHANNEL-ROW + qa.js R-MISS-05] [ENFORCED] Same guarantee for EMAIL: captured emails but an empty read → the row ships deterministically ("New email: …" / "No new emails — latest: …"); the audit pings R-MISS-05 if an Email row is ever missing while emails are captured (founder, 13 Aug — Smooche: 16 emails incl. "Smooche is now on Amazon!", no Email row)
- [slack.js R-SOCIAL-ROW + qa.js R-MISS-04] [ENFORCED] A channel the app displays always gets a row: if posts are captured but the AI social read gated to empty, the row ships deterministically — new-post line, else "No new posts on the tracked profiles." An empty read can never silently drop a channel; the self-audit pings R-MISS-04 if it ever happens (founder, 12 Aug — Pacific Foods: 9 IG posts in the app, no Social row in the brief)
- [slack.js] [ENFORCED] No verdict quotes in the brief (clipped nonsense, 10 Aug); every block carries one ads-recap line with the core message (client feedback, 8 Aug)
- [slack.js + rulecheck.js] [ENFORCED] DELIVERY GATE: every line passes rulecheck after scrubbing; violations → deterministic fallback text + QA ping to founder (12 Aug)
- [qa.js] [ENFORCED] SELF-AUDIT after real sends: deterministic miss-checks + model judge over delivered text vs computed facts; issues ping the founder's Slack (12 Aug)
- [signals.js] [ENFORCED] Priority order: sale change → funnel → new FB page → products → ad angle; conservative (unsure → silent); ONE definition of new (findings engine is sole authority, 6 Aug)
- [slack.js] [ENFORCED] **DECIDED (founder, 14 Aug): ad launches stay ROUTINE regardless of batch size** — even a 16-launch day is creative rotation, not a 💡 priority move; the 💡 set stays sale change / funnel / new page / products / new angle. Do not re-litigate by adding a launch-count threshold
- [signals.js] [ENFORCED] New funnel = first appearance since Monday, labelled "(first seen <day>, still new this week)" (founder, 24 Jul)
- [signals.js] [ENFORCED] Same-type signals merge into one line (founder, 22 Jul); spare formatting (badge carries status)
- [slack.js R-EMOJI-01] [ENFORCED] No decorative emojis anywhere in the brief — channel rows are plain labels ("Ads:", "Social:", "Website:", "Email:"), no header satellite. Only FUNCTIONAL markers survive: ❗ new-signal, 💡/🔹/✅ status badge, 🧯 QA pings ("this update looks like a joke" — founder, 13 Aug)
- [slack.js] [ENFORCED] Badges: 💡 priority / 🔹 routine / ✅ quiet; stale reads (>2 days) never quoted as fresh; missing reads → deterministic lines so news is never dropped
- [slack.js] [ENFORCED] Demo brands appended and labelled, never mixed in (founder, 6 Aug)
- [signals.js] [ENFORCED] Only REAL deliveries commit announce-once state — previews never consume it

## Weekly report

- [weekly.js] [ENFORCED] Findings-first; headline/summary/channel text passes the claims gate; no active-ad or product totals; only genuinely-launched ads and this-week posts/emails cited
- [weekly.js R-WEEKLY-GATE] [ENFORCED] **The weekly passes the same MECHANICAL gate as the daily** (rulecheck: totals, meta-commentary, truncation corpses, unbalanced quotes, performance claims) — a client reads daily and weekly side by side, so the weekly may never drift below the daily's floor. Violating bullets are dropped; a violating headline is kept (a report needs one) but every violation QA-pings the founder (19 Aug audit)
- [weekly.js] [ENFORCED] Every launched ad counts, no dedup (founder, 20 Jul); sale STATUS never discounted-product counts
- [weekly.js] [PROMPT] Channel inactivity only when data explicitly says nothing was published; engagement is lifetime; materiality filter; output-shape limits (headline ≤14 words, etc.)
- [weekly.js] [ENFORCED] Served weekly = most recent COMPLETED Mon–Sun week; social aggregated across daily captures deduped by URL
- [weekly.js + brand.js] [ENFORCED] Tenant-neutral: no customer's brand/prices in shared rows; founder's own brand removed from anything client-visible

## General honesty / grounding (the prime directive)

- [insights.js] [PROMPT] **CREDIBILITY IS THE PRODUCT**: one wrong or overconfident claim costs more trust than ten missed insights; hedge in the sentence or leave it out — every other rule serves this one
- [findings.js + insights.js] [ENFORCED] Findings-first architecture: code decides WHAT is true, the model only phrases it; provable or absent
- [claims.js] [ENFORCED] Deterministic claim validator is the last gate before storage — "prompt rules alone never held"; unsupported sentences removed; stripping never leaves fragments; every block logged
- [claims.js] [ENFORCED] No contradiction of the computed diff; no "new" for known entities; no identity guesses ("most likely X" banned); honest limitation statements always pass
- [insights.js] [BOTH] Sense-check LLM judge on every read; full-section gate (summary + bullets + apply) with deterministic re-gate LAST; threat assessment gets the strictest gate; rejected text is never restored, fallback prefers substance over inventory boilerplate (founder, 11 Aug)
- [insights.js] [BOTH] Stay inside the evidence: never spend/revenue/traffic/conversions, never "primary growth engine"; like-for-like dated comparisons are wanted
- [insights.js] [PROMPT] Reader test, usefulness test, materiality filter, calibrated certainty (facts flat, inferences hedged), sanity-check every number
- [insights.js] [ENFORCED] Tenant-neutral shared reads; per-viewer tailoring is a private overlay; skipped read failures ledgered, never silent
- [rulecheck.js R-TEXT-03] [ENFORCED] No placeholder junk (undefined/null/NaN) on any surface
