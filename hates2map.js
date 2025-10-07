/* ===== Back2Maps — SPLC-style bubble heat map ===== */
(() => {
  "use strict";

  const CFG = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID = "b2m-map";
  const DIV_ZOOM = +(document.querySelector(".back2maps")?.dataset?.divzoom || CFG.minZoomForDiv || 6);

  const STATES_URL  = CFG.statesUrl    || "australian-states.min.geojson";
  const REGIONS_URL = CFG.divisionsUrl || "regional_div.json";
  const CSV_URL     = CFG.cioDataCsv   || "testData.csv";
  const XLSX_URL    = CFG.cioDataXlsx  || "testData.xlsx";
  const SUBURBS_URL = CFG.suburbLookup || "";
  const AU_BOUNDS   = [[-44.0, 112.0], [-10.0, 154.0]];

  const STS = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState = s => { const x=(s??"").trim().toUpperCase(); return STS.has(x)?x:""; };
  const asPostcode = s => { const x=(s??"").replace(/\s+/g,""); return /^\d{4}$/.test(x)?x:""; };
  const LOG = (...a)=>console.log("[B2M]",...a);

  const fetchText = (url) => fetch(url,{cache:"no-cache"}).then(r=>r.ok?r.text():"");
  const fetchJSON = (url) => fetch(url,{cache:"no-cache"}).then(r=>r.ok?r.json():null).catch(()=>null);

  function parseCSV(txt){
    const [h,...rows]=txt.trim().split(/\r?\n/).map(r=>r.split(","));
    return rows.map(r=>Object.fromEntries(r.map((v,i)=>[h[i].trim(),v.trim()])));
  }

  // Approximate centroid for polygon
  function centroid(coords){
    if (!coords || !coords.length) return null;
    let x=0,y=0,len=0;
    coords[0].forEach(([lon,lat])=>{x+=lon;y+=lat;len++;});
    return len? [y/len,x/len]:null;
  }

  // Bubble style (SPLC look)
  function bubbleStyle(count){
    const r = Math.sqrt(count)*2.2; // scale radius by sqrt
    return {
      radius: r,
      fillColor: "#d93b2b",
      color: "#a11e14",
      weight: 0.5,
      fillOpacity: 0.7,
      opacity: 0.4
    };
  }

  function makeLabel(text){
    return L.divIcon({
      html: `<div style="color:white;font-size:11px;font-weight:600;text-align:center;line-height:1">${text}</div>`,
      className: "b2m-bubble-label",
      iconSize: [20,20]
    });
  }

  async function buildMap(){
    if (typeof L==="undefined") return console.error("[B2M] Leaflet missing");
    const map = L.map(ROOT_ID,{zoomControl:true,minZoom:3,maxZoom:10});
    map.fitBounds(AU_BOUNDS);

    const [states, regions] = await Promise.all([
      fetchJSON(STATES_URL),
      fetchJSON(REGIONS_URL)
    ]);
    const csvText = await fetchText(CSV_URL);
    const rows = csvText ? parseCSV(csvText) : [];
    LOG("Loaded rows:",rows.length);

    // Draw base map (beige tone)
    if (states?.features){
      L.geoJSON(states,{
        style:{color:"#fff",weight:1,fillColor:"#f4ebdf",fillOpacity:1}
      }).addTo(map);
    }

    if (!regions?.features?.length || !rows.length) return;

    // Count per region (using postcode/state columns)
    const counts = {};
    for (const o of rows){
      const st = asState(o.State||o["State / Territory"]);
      if (!st) continue;
      counts[st] = (counts[st]||0)+1;
    }

    // Add faint outlines of regions
    const regionLayer = L.geoJSON(regions,{
      style:{color:"#fff",weight:0.5,fillOpacity:0.05}
    }).addTo(map);

    // Create bubble markers per region centroid
    for (const f of regions.features){
      const id = f.properties?.name || f.properties?.id;
      const st = f.properties?.state || f.properties?.ST || "";
      const count = counts[st] || 0;
      if (!count) continue;
      const g = f.geometry;
      let c = null;
      if (g.type==="Polygon") c = centroid(g.coordinates);
      else if (g.type==="MultiPolygon") c = centroid(g.coordinates[0]);
      if (!c) continue;
      const [lat,lon] = c;
      const marker = L.circleMarker([lat,lon], bubbleStyle(count)).addTo(map);
      marker.bindTooltip(`${st}: ${count} report(s)`,{permanent:false});
      L.marker([lat,lon],{icon:makeLabel(count)}).addTo(map);
    }

    LOG("Bubble markers ready");
  }

  document.addEventListener("DOMContentLoaded",buildMap);
})();
