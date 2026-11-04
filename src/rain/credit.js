// ====================================================================
// A rainfall product's credit as DOM: the provider's wording and the licence,
// for the panel and the hydrograph section (the map's is map/credits.js).
// ====================================================================
import { RAIN_LICENSE_URL, RAIN_PRODUCTS } from "../config.js";

function link(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
  return a;
}

export function renderRainCredit(el, productKey) {
  const { long, url } = RAIN_PRODUCTS[productKey].credit;
  el.replaceChildren(link(url, long), " ", link(RAIN_LICENSE_URL, "CC BY 4.0"));
}
