(function (Drupal, drupalSettings) {
    "use strict";
  
    const S = (drupalSettings && drupalSettings.uky_utm) || {};
    const CONFIG = {
      cookieName: S.cookieName || "utm_session",
      ttlMinutes: Number(S.ttlMinutes || 30),
      landingMode: S.landingMode || "absolute",
      debug: !!S.debug,
      mappings: Array.isArray(S.mappings) ? S.mappings : [],
      referrer: S.referrer || { enabled: false, attribute_name: "", attribute_value: "" },
    };
  
    // Tags to mark auto-populated fields so we can safely clear old targets.
    const TAGS = { utm: "uky_utm:utm", ref: "uky_utm:referrer" };
    const REF_TGT_KEY = "uky_utm__referrer_target";
  
    // --- Known domains / sources (extend as needed) -----------------------------
    const SOCIAL_DOMAINS = [
      "facebook.com","instagram.com","t.co","twitter.com","x.com","linkedin.com",
      "reddit.com","pinterest.com","tiktok.com","snapchat.com","youtube.com"
    ];
    const SEARCH_ENGINE_DOMAINS = [
      "google.","bing.com","yahoo.","duckduckgo.com","yandex.","baidu.com","ecosia.org"
    ];
    const SOCIAL_SOURCES = [
      "facebook","instagram","meta","linkedin","twitter","x","reddit","pinterest","tiktok","snapchat","youtube"
    ];
  
    // --- Ad platform canon + synonyms ------------------------------------------
    // Canonical IDs -> labels
    const PLATFORM_META = {
      google:   "Google Ads",
      microsoft:"Microsoft Advertising",
      meta:     "Meta Ads",
      tiktok:   "TikTok Ads",
      linkedin: "LinkedIn Ads",
      twitter:  "X (Twitter) Ads",
      pinterest:"Pinterest Ads",
      snap:     "Snapchat Ads",
      yandex:   "Yandex Ads",
      taboola:  "Taboola",
      outbrain: "Outbrain",
    };
  
    // UTM/source synonyms -> canonical ID
    // (order matters only for ties; we also record a "detail" like 'facebook' vs 'instagram')
    const UTM_PLATFORM_SYNONYMS = [
      { id: "google",    tokens: ["google","adwords","googleads","gads","ga"] },
      { id: "microsoft", tokens: ["bing","microsoft","msft","msads","microsoftads","adcenter"] },
      { id: "meta",      tokens: ["facebook","fb","instagram","ig","meta"] },
      { id: "tiktok",    tokens: ["tiktok","tt"] },
      { id: "linkedin",  tokens: ["linkedin","li","lnkd"] },
      { id: "twitter",   tokens: ["twitter","x","tw"] },
      { id: "pinterest", tokens: ["pinterest","pin"] },
      { id: "snap",      tokens: ["snap","snapchat"] },
      { id: "yandex",    tokens: ["yandex"] },
      { id: "taboola",   tokens: ["taboola"] },
      { id: "outbrain",  tokens: ["outbrain"] },
    ];
  
    // Click-ID parameter names by platform and priority
    const CLICK_ID_KEYS = {
      google:   ["gclid","gbraid","wbraid"],
      microsoft:["msclkid"],
      meta:     ["fbclid"],
      tiktok:   ["ttclid"],
      linkedin: ["li_fat_id"],
      twitter:  ["twclid"],
      pinterest:["epik"],
      snap:     ["sc_click_id"],
      yandex:   ["yclid"],
      taboola:  ["tbclid"],
      outbrain: ["ob_click_id"],
    };
    const PLATFORM_PRIORITY = [
      "google","meta","microsoft","tiktok","linkedin","twitter","pinterest","snap","yandex","taboola","outbrain"
    ];
  
    // Confidence ranking for platform inference
    const CONF_RANK = { low: 1, medium: 2, high: 3 };
  
    // --- URL helpers ------------------------------------------------------------
    function getParam(name) {
      const qs = new URLSearchParams(location.search);
      const hs = new URLSearchParams((location.hash || "").replace(/^#/, ""));
      return qs.get(name) || hs.get(name) || "";
    }
    function getUtm(name) {
      const p = new URLSearchParams(location.search);
      return (p.get("utm_" + name) || "").trim();
    }
    function hasAnyUtm() {
      const p = new URLSearchParams(location.search);
      for (const k of p.keys()) if (k.toLowerCase().startsWith("utm_")) return true;
      return false;
    }
    function normaliseHost(host) {
      try { return host.replace(/^www\./i, "").toLowerCase(); }
      catch { return (host || "").toLowerCase(); }
    }
    function hostMatches(list, host) {
      const h = normaliseHost(host);
      return list.some(d => h === d || h.endsWith("." + d) || (d.endsWith(".") && h.startsWith(d)));
    }
  
    // --- Click-ID detection -----------------------------------------------------
    function detectClickId() {
      const found = [];
      for (const [platform, keys] of Object.entries(CLICK_ID_KEYS)) {
        for (const key of keys) {
          const value = getParam(key);
          if (value) found.push({ platform, key, value });
        }
      }
      if (!found.length) return null;
      found.sort((a, b) => PLATFORM_PRIORITY.indexOf(a.platform) - PLATFORM_PRIORITY.indexOf(b.platform));
      const primary = found[0];
      const all = {};
      for (const f of found) all[f.key] = f.value;
      return { ...primary, all }; // platform, key, value, all
    }
  
    // --- Platform inference -----------------------------------------------------
    function inferPlatformFromUtm() {
      const source = getUtm("source").toLowerCase();
      const medium = getUtm("medium").toLowerCase();
      // GA4 utm_source_platform (if present) helps too
      const srcPlatform = (getUtm("source_platform") || "").toLowerCase();
  
      const candidates = [srcPlatform, source, medium].filter(Boolean);
      if (!candidates.length) return null;
  
      for (const c of candidates) {
        for (const entry of UTM_PLATFORM_SYNONYMS) {
          const hit = entry.tokens.find(t => c === t || c.includes(t));
          if (hit) {
            // detail: which token hit (e.g., 'facebook' vs 'instagram')
            return {
              id: entry.id,
              label: PLATFORM_META[entry.id] || entry.id,
              detail: hit,
              via: "utm",
              confidence: "medium",
            };
          }
        }
      }
      return null;
    }
  
    function inferPlatformFromReferrer(channel) {
      // Only attempt a low-confidence guess for paid social when no UTM / click IDs.
      if (channel !== "Paid social") return null;
      const ref = (document.referrer || "").trim();
      let host = "";
      try { host = ref ? new URL(ref).host : ""; } catch {}
      const h = normaliseHost(host);
      if (!h) return null;
  
      if (h.includes("facebook.") || h.includes("instagram.") || h.includes("meta.")) {
        return { id: "meta", label: PLATFORM_META.meta, detail: h.includes("instagram.") ? "instagram" : "facebook", via: "referrer", confidence: "low" };
      }
      if (h.includes("tiktok."))    return { id: "tiktok",   label: PLATFORM_META.tiktok,   detail: "tiktok",   via: "referrer", confidence: "low" };
      if (h.includes("linkedin."))  return { id: "linkedin", label: PLATFORM_META.linkedin, detail: "linkedin", via: "referrer", confidence: "low" };
      if (h.includes("twitter.") || h.includes("x.")) {
        return { id: "twitter", label: PLATFORM_META.twitter, detail: "twitter", via: "referrer", confidence: "low" };
      }
      if (h.includes("pinterest.")) return { id: "pinterest",label: PLATFORM_META.pinterest,detail: "pinterest",via: "referrer", confidence: "low" };
      if (h.includes("snapchat."))  return { id: "snap",     label: PLATFORM_META.snap,     detail: "snapchat", via: "referrer", confidence: "low" };
      return null;
    }
  
    function choosePlatform(existing, candidate) {
      if (!candidate) return existing || null;
      if (!existing)  return candidate;
      const a = CONF_RANK[existing.confidence || "low"] || 1;
      const b = CONF_RANK[candidate.confidence || "low"] || 1;
      return (b >= a) ? candidate : existing;
    }
  
    // --- Cookie store -----------------------------------------------------------
    const CookieStore = (() => {
      const read = (name) => {
        try {
          const raw = document.cookie
            .split(";")
            .map((v) => v.trim())
            .find((v) => v.startsWith(name + "="))
            ?.split("=")[1] || "";
          return JSON.parse(decodeURIComponent(raw) || "{}");
        } catch { return {}; }
      };
      const write = (name, obj, minutes) => {
        const v = encodeURIComponent(JSON.stringify(obj));
        const expires = new Date(Date.now() + minutes * 60 * 1000).toUTCString();
        const secure = location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${name}=${v}; Path=/; SameSite=Lax; Expires=${expires}${secure}`;
      };
      return { read, write };
    })();
  
    // --- Classification (channel + drilldowns) ---------------------------------
    function classifyTraffic() {
      const medium = getUtm("medium").toLowerCase();
      const source = getUtm("source").toLowerCase();
      const campaign = getUtm("campaign");
      const term = getUtm("term");
      const content = getUtm("content");
  
      const click = detectClickId();
      const ref = (document.referrer || "").trim();
      let refHost = "";
      try { refHost = ref ? new URL(ref).host : ""; } catch {}
  
      // 1) UTMs present → trust them.
      if (hasAnyUtm()) {
        // Display
        if (medium === "display") {
          return { channel: "Display", drilldown1: source || "No Source", drilldown2: campaign || "No Campaign", drilldown3: term || "No Terms", drilldown4: content || "No Content" };
        }
        // Email
        if (medium === "email" || [source, medium, (campaign||"").toLowerCase()].some(v => (v || "").includes("email"))) {
          return { channel: "Email marketing", drilldown1: source || "No Source", drilldown2: campaign || "No Campaign", drilldown3: term || "No Terms", drilldown4: content || "No Content" };
        }
        // Paid social
        const isPaidish = ["paid","ppc","cpc","paidsocial"].includes(medium) || source === "paidsocial";
        const looksSocial = SOCIAL_SOURCES.includes(source) || hostMatches(SOCIAL_DOMAINS, refHost);
        if (isPaidish && looksSocial) {
          return { channel: "Paid social", drilldown1: source || "No Source", drilldown2: campaign || "No Campaign", drilldown3: term || "No Terms", drilldown4: content || "No Content" };
        }
        // Affiliates
        if (["affiliate","affiliates"].includes(medium)) {
          return { channel: "Affiliates", drilldown1: source || "No Source", drilldown2: campaign || "No Campaign", drilldown3: term || "No Terms", drilldown4: content || "No Content" };
        }
        // Paid search
        const isPaidSearchish = ["adword","ppc","cpc","paidsearch"].includes(medium) || source === "paidsearch";
        if (isPaidSearchish || (click && (click.platform === "google" || click.platform === "microsoft" || click.platform === "yandex"))) {
          return { channel: "Paid search", drilldown1: source || "No Source", drilldown2: campaign || "No Campaign", drilldown3: term || "No Terms", drilldown4: content || "No Content" };
        }
        // Other campaigns
        return { channel: "Other campaigns", drilldown1: source || "No Source", drilldown2: campaign || "No Campaign", drilldown3: term || "No Terms", drilldown4: content || "No Content" };
      }
  
      // 2) No UTMs, but click IDs present → infer.
      if (click) {
        const srcDefaults = {
          google:   { channel: "Paid search",  source: "google"   },
          microsoft:{ channel: "Paid search",  source: "bing"     },
          yandex:   { channel: "Paid search",  source: "yandex"   },
          meta:     { channel: "Paid social",  source: "facebook" },
          tiktok:   { channel: "Paid social",  source: "tiktok"   },
          linkedin: { channel: "Paid social",  source: "linkedin" },
          twitter:  { channel: "Paid social",  source: "twitter"  },
          pinterest:{ channel: "Paid social",  source: "pinterest"},
          snap:     { channel: "Paid social",  source: "snapchat" },
          taboola:  { channel: "Display",      source: "taboola"  },
          outbrain: { channel: "Display",      source: "outbrain" },
        };
        const d = srcDefaults[click.platform] || { channel: "Other campaigns", source: click.platform };
        return { channel: d.channel, drilldown1: d.source, drilldown2: "No Campaign", drilldown3: "No Terms", drilldown4: "No Content" };
      }
  
      // 3) Neither UTMs nor click IDs → classify by referrer
      if (!ref) {
        return { channel: "Direct traffic", drilldown1: "None", drilldown2: "None", drilldown3: "None", drilldown4: "None" };
      }
      if (hostMatches(SOCIAL_DOMAINS, refHost)) {
        return { channel: "Organic social", drilldown1: normaliseHost(refHost), drilldown2: refHost, drilldown3: "None", drilldown4: "None" };
      }
      if (hostMatches(SEARCH_ENGINE_DOMAINS, refHost)) {
        return { channel: "Organic search", drilldown1: normaliseHost(refHost), drilldown2: refHost, drilldown3: "None", drilldown4: "None" };
      }
      if (refHost && normaliseHost(refHost) === normaliseHost(location.host)) {
        return { channel: "Direct traffic", drilldown1: "None", drilldown2: "None", drilldown3: "None", drilldown4: "None" };
      }
      return { channel: "Referral", drilldown1: refHost || "None", drilldown2: ref || "None", drilldown3: "None", drilldown4: "None" };
    }
  
    // --- Session capture (URL-change aware) ------------------------------------
    const Session = (() => {
      const getLanding = (mode) => {
        const { protocol, host, pathname, search } = location;
        switch (mode) {
          case "path": return pathname;
          case "path+query": return pathname + (search || "");
          case "absoluteNoQuery": return `${protocol}//${host}${pathname}`;
          case "absolute":
          default: return `${protocol}//${host}${pathname}${search || ""}`;
        }
      };
  
      const capture = () => {
        const bag = CookieStore.read(CONFIG.cookieName) || {};
  
        // Landing page set once.
        if (!bag.landingpage) bag.landingpage = getLanding(CONFIG.landingMode);
  
        // Apply/refresh UTM params
        const params = new URLSearchParams(location.search);
        let sawAnyUtm = false;
        for (const [k, v] of params.entries()) {
          if (k.toLowerCase().startsWith("utm_")) {
            const key = k.slice(4).toLowerCase(); // source, medium, campaign, term, content
            if (v !== null && v !== undefined && v !== "") bag[key] = v;
            else delete bag[key];
            sawAnyUtm = true;
          }
        }
  
        // Click ID detection (high confidence)
        const click = detectClickId();
        if (click) {
          bag.ad_platform       = click.platform;                // canonical ID (e.g., 'google')
          bag.ad_platform_label = PLATFORM_META[click.platform] || click.platform;
          bag.ad_platform_detail= click.platform;                // same as ID; UTMs may refine (e.g., 'facebook' vs 'instagram')
          bag.ad_platform_confidence = "high";
          bag.ad_platform_via   = "click_id";
          bag.ad_click_id       = `${click.key}:${click.value}`;
          bag.click_ids         = { ...(bag.click_ids || {}), ...click.all };
  
          // Optional defaults if UTMs missing
          const defaults = {
            google:   { source: "google",   medium: "cpc" },
            microsoft:{ source: "bing",     medium: "cpc" },
            yandex:   { source: "yandex",   medium: "cpc" },
            meta:     { source: "facebook", medium: "paid_social" },
            tiktok:   { source: "tiktok",   medium: "paid_social" },
            linkedin: { source: "linkedin", medium: "paid_social" },
            twitter:  { source: "twitter",  medium: "paid_social" },
            pinterest:{ source: "pinterest",medium: "paid_social" },
            snap:     { source: "snapchat", medium: "paid_social" },
            taboola:  { source: "taboola",  medium: "display" },
            outbrain: { source: "outbrain", medium: "display" },
          };
          if (!bag.source && defaults[click.platform]) bag.source = defaults[click.platform].source;
          if (!bag.medium && defaults[click.platform]) bag.medium = defaults[click.platform].medium;
        }
  
        // UTM platform inference (medium confidence)
        const utmPlat = inferPlatformFromUtm(); // {id,label,detail,via,confidence}
        if (utmPlat) {
          // Prefer the stronger signal (click ID > UTM). If click ID was set, keep it;
          // but allow UTM to refine detail (e.g., fbclid + utm_source=instagram).
          if (!bag.ad_platform || CONF_RANK["medium"] >= CONF_RANK[bag.ad_platform_confidence || "low"]) {
            bag.ad_platform = utmPlat.id;
            bag.ad_platform_label = utmPlat.label;
            bag.ad_platform_confidence = "medium";
            bag.ad_platform_via = "utm";
          }
          // Always allow UTM to refine "detail".
          if (utmPlat.detail) bag.ad_platform_detail = utmPlat.detail;
        }
  
        if (sawAnyUtm && bag.source) bag._last_source = bag.source;
  
        // Compute channel & drilldowns (always update)
        const ch = classifyTraffic();
        bag.channel    = ch.channel;
        bag.drilldown1 = ch.drilldown1;
        bag.drilldown2 = ch.drilldown2;
        bag.drilldown3 = ch.drilldown3;
        bag.drilldown4 = ch.drilldown4;
  
        // Infer ad_network from channel (useful for reporting/segmenting)
        // search | paid_social | display | native | email | affiliates | other | organic_social | organic_search | referral | direct
        const channelToNetwork = {
          "Paid search": "search",
          "Paid social": "paid_social",
          "Display": "display",
          "Affiliates": "affiliates",
          "Email marketing": "email",
          "Other campaigns": "other",
          "Organic social": "organic_social",
          "Organic search": "organic_search",
          "Referral": "referral",
          "Direct traffic": "direct",
        };
        bag.ad_network = channelToNetwork[bag.channel] || "other";
  
        // If no platform yet, try a last-ditch low-confidence guess from referrer (only for Paid social).
        if (!bag.ad_platform) {
          const low = inferPlatformFromReferrer(bag.channel); // low confidence
          if (low) {
            bag.ad_platform = low.id;
            bag.ad_platform_label = low.label;
            bag.ad_platform_detail = low.detail;
            bag.ad_platform_confidence = "low";
            bag.ad_platform_via = "referrer";
          }
        }
  
        CookieStore.write(CONFIG.cookieName, bag, CONFIG.ttlMinutes);
  
        if (CONFIG.debug) {
          console.groupCollapsed("[UKY UTM] captured & classified (" + CONFIG.cookieName + ")");
          console.table(bag);
          console.groupEnd();
        }
      };
  
      const installUrlWatch = () => {
        const _push = history.pushState;
        const _replace = history.replaceState;
        history.pushState = function () { const r = _push.apply(this, arguments); try { capture(); } catch {} return r; };
        history.replaceState = function () { const r = _replace.apply(this, arguments); try { capture(); } catch {} return r; };
        window.addEventListener("popstate", () => { try { capture(); } catch {} });
      };
  
      const get = (key) => (CookieStore.read(CONFIG.cookieName) || {})[key];
  
      return { capture, installUrlWatch, get };
    })();
  
    // --- Field population -------------------------------------------------------
    function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }
    function selectorForAttr(attr, value) {
      if (attr === 'class') return `[class~="${cssEscape(value)}"]`;
      return `[${attr}="${cssEscape(value)}"]`;
    }
    function tagAndDispatch(el, tag) {
      el.setAttribute("data-populated-by", tag);
      try {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    }
    function applyValue(el, value, tag) {
      if (el.tagName === "SELECT") {
        const hasOption = Array.from(el.options).some(o => o.value === value);
        if (!hasOption) return false;
      }
      el.value = value;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.setAttribute("value", value);
        try { el.defaultValue = value; } catch {}
      }
      tagAndDispatch(el, tag);
      return true;
    }
    function clearIfTagged(el, tag) {
      if (el.getAttribute("data-populated-by") !== tag) return false;
      el.value = "";
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.setAttribute("value", "");
        try { el.defaultValue = ""; } catch {}
      }
      tagAndDispatch(el, tag);
      return true;
    }
  
    function processUtmMappings() {
      if (!CONFIG.mappings.length) return 0;
      let updated = 0, scanned = 0;
  
      CONFIG.mappings.forEach((m) => {
        const key = (m.utm_key || '').trim().toLowerCase(); // supports 'source','medium','campaign','landingpage','channel','drilldown1','ad_platform','ad_platform_label', etc.
        const attr = (m.attribute_name || 'id').trim();
        const attrVal = (m.attribute_value || '').trim();
        if (!key || !attrVal) return;
  
        const val = Session.get(key);
        if (val == null || val === "") return;
  
        const sel = selectorForAttr(attr, attrVal);
        const nodes = document.querySelectorAll(`input${sel}, textarea${sel}, select${sel}`);
        nodes.forEach((el) => { scanned++; if (applyValue(el, val, TAGS.utm)) updated++; });
      });
  
      if (CONFIG.debug) {
        console.info(`[UKY UTM] UTM/classified populated ${updated}/${scanned} fields from ${CONFIG.mappings.length} mapping(s).`);
      }
      return updated;
    }
  
    // --- Referrer assignment ----------------------------------------------------
    function processReferrerMapping() {
      const R = CONFIG.referrer || {};
      if (!R.enabled) return 0;
      const attr = (R.attribute_name || '').trim();
      const val = (R.attribute_value || '').trim();
      if (!attr || !val) return 0;
  
      const rawRef = (document.referrer || "").trim();
      const ref = rawRef ? rawRef : "Direct Traffic";
  
      const sel = selectorForAttr(attr, val);
      const nodes = document.querySelectorAll(`input${sel}, textarea${sel}, select${sel}`);
  
      let updated = 0, scanned = 0;
      nodes.forEach((el) => { scanned++; if (applyValue(el, ref, TAGS.ref)) updated++; });
  
      if (CONFIG.debug) {
        console.info(`[UKY UTM] Referrer populated ${updated}/${scanned} field(s). Value used: "${ref}"`);
      }
      return updated;
    }
  
    function clearOldReferrerTarget(prev) {
      if (!prev || !prev.attribute_name || !prev.attribute_value) return 0;
      const sel = selectorForAttr(prev.attribute_name, prev.attribute_value);
      const nodes = document.querySelectorAll(`input${sel}, textarea${sel}, select${sel}`);
      let cleared = 0;
      nodes.forEach((el) => { if (clearIfTagged(el, TAGS.ref)) cleared++; });
      if (CONFIG.debug && cleared) console.info(`[UKY UTM] Cleared ${cleared} previous referrer field(s) for`, prev);
      return cleared;
    }
  
    // --- Boot -------------------------------------------------------------------
    function boot() {
      Session.capture();
      Session.installUrlWatch();
  
      let prev = null;
      try { prev = JSON.parse(localStorage.getItem(REF_TGT_KEY) || "null"); } catch {}
      const curr = (CONFIG.referrer && CONFIG.referrer.enabled && CONFIG.referrer.attribute_name && CONFIG.referrer.attribute_value)
        ? { attribute_name: CONFIG.referrer.attribute_name, attribute_value: CONFIG.referrer.attribute_value }
        : null;
  
      const prevJson = prev ? JSON.stringify(prev) : "";
      const currJson = curr ? JSON.stringify(curr) : "";
      if (prevJson && prevJson !== currJson) clearOldReferrerTarget(prev);
      else if (prevJson && !currJson)       clearOldReferrerTarget(prev);
      if (curr) localStorage.setItem(REF_TGT_KEY, JSON.stringify(curr));
      else      localStorage.removeItem(REF_TGT_KEY);
  
      const run = () => {
        processReferrerMapping(); // referrer first
        processUtmMappings();
  
        // retry window to catch late fields
        let tries = 0;
        const max = 20, delay = 120;
        (function again() {
          const n = processReferrerMapping() + processUtmMappings();
          if (n === 0 && tries < max) { tries++; setTimeout(again, delay); }
        })();
      };
  
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, { once: true });
      } else {
        run();
      }
  
      // Observe DOM changes (SPA/AJAX)
      const mo = new MutationObserver(() => {
        clearTimeout(mo._t);
        mo._t = setTimeout(() => { processReferrerMapping(); processUtmMappings(); }, 60);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
  
      // Safety before submit
      document.addEventListener("submit", () => { processReferrerMapping(); processUtmMappings(); }, true);
    }
  
    Drupal.behaviors.ukyUtm = {
      attach(context) {
        if (context === document && !window.__ukyUtmInit) {
          window.__ukyUtmInit = true;
          boot();
        }
      },
    };
  
  })(Drupal, drupalSettings);
  