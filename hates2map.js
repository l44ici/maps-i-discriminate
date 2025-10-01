/* ===== Back2Maps — regions + CSV/XLSX choropleth + markers ===== */
(() => {
  "use strict";

  const AU_BOUNDS = [[-44.0,112.0],[-10.0,154.0]];
  const fmt = n => new Intl.NumberFormat().format(n);

  // ---------- general helpers ----------
  const pick = (row, keys) => { for (const k of keys) { if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") return String(row[k]).trim(); } return undefined; };
  const getLat    = r => parseFloat(pick(r, ["lat","Lat","LAT","latitude","Latitude"]));
  const getLon    = r => parseFloat(pick(r, ["lon","Lon","LON","lng","Lng","LNG","longitude","Longitude"]));
  const getState  = r => pick(r, ["State / Territory","State","state","STATE","Territory"]);
  const getPC     = r => { const v = pick(r, ["Post Code","postcode","Postcode","PC","Pcode","Zip"]); return v ? String(v).replace(/\D/g,"").padStart(4,"0") : undefined; };
  const getSuburb = r => pick(r, ["Suburb","suburb","Town","Locality","City"]);

  const regionIdOf = f => { const p = (f && f.properties) || {}; return p.division_code || p.region_id || p.REGION_ID || p.code || p.id || p.name; };
  const regionStateOf = f => { const p = (f && f.properties) || {}; return p.state || p.STATE || p.State || p.st || null; };

  function getColor(d){ return d>40?"#7f0000":d>30?"#b30000":d>20?"#d7301f":d>10?"#ef6548":d>5?"#fdbb84":d>0?"#fee8c8":"#f7f7f7"; }
  const styleForCount = c => ({ weight:1, color:"#71797E", fillOpacity:0.65, fillColor:getColor(c||0) });

  // ---------- loaders ----------
  async function fetchJSON(url){ const r=await fetch(url,{cache:"no-cache"}); if(!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
  async function fetchText(url){ const r=await fetch(url,{cache:"no-cache"}); if(!r.ok) throw new Error(`${r.status} ${url}`); return r.text(); }
  async function fetchArrayBuffer(url){ const r=await fetch(url,{cache:"no-cache"}); if(!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); }

  async function loadCSVorXLSX(csvUrl, xlsxUrl){
    // try CSV first
    try {
      const csv = await fetchText(csvUrl);
      if (csv && csv.trim().length) {
        return await new Promise((res,rej)=>Papa.parse(csv,{header:true,skipEmptyLines:true,transformHeader:h=>String(h).trim(),complete: r=>res(r.data||[]),error:rej}));
      }
    } catch(_) { /* will try XLSX */ }
    // XLSX fallback
    try {
      const buf = await fetchArrayBuffer(xlsxUrl);
      const wb  = XLSX.read(buf, { type: "array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(ws, { defval:"", raw:false });
    } catch(e) {
      console.error("[B2M] No CSV/XLSX data found", e);
      return [];
    }
  }

  async function loadDivisions(url, objName){
    const raw = await fetchJSON(url);
    if (raw?.type === "FeatureCollection") return raw;
    if (raw?.type === "Topology" && window.topojson) {
      const key = (objName||"").trim() || Object.keys(raw.objects||{})[0];
      const fc  = topojson.feature(raw, raw.objects[key]);
      return (fc.type === "FeatureCollection") ? fc : { type:"FeatureCollection", features:[fc] };
    }
    throw new Error("Unknown divisions format");
  }

  // ---------- suburb/postcode lookup (optional) ----------
  let suburbIndex = null; // "STATE|SUBURB|POSTCODE" -> [lon,lat]
  function buildSuburbIndex(geojson) {
    const map = new Map();
    if (!geojson?.features) return map;
    for (const f of geojson.features) {
      if (f?.geometry?.type !== "Point") continue;
      const [lon, lat] = f.geometry.coordinates || [];
      const P = f.properties || {};
      const s  = String(P.state || P.State || "").toUpperCase();
      const sb = String(P.suburb || P.Suburb || P.locality || "").toUpperCase();
      const pc = String(P.postcode || P.Postcode || P.pc || "").replace(/\D/g,"");
      const keys = new Set([[s,sb,pc],[s,sb,""],["",sb,pc]].map(a=>a.join("|")));
      for (const k of keys) if (k.replaceAll("|","") !== "") map.set(k,[lon,lat]);
    }
    return map;
  }
  function lookupCoords(state, suburb, pc) {
    if (!suburbIndex) return null;
    const s  = String(state||"").toUpperCase();
    const sb = String(suburb||"").toUpperCase();
    const p  = (pc||"").replace(/\D/g,"");
    for (const k of [[s,sb,p],[s,sb,""],["",sb,p]].map(a=>a.join("|"))) if (suburbIndex.has(k)) return suburbIndex.get(k);
    return null;
  }

  // ---------- main ----------
  document.addEventListener("DOMContentLoaded", async () => {
    // Map
    const map = L.map("b2m-map", { preferCanvas:true, worldCopyJump:true });
    map.fitBounds(AU_BOUNDS);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{ attribution:'&copy; OpenStreetMap', maxZoom:18 }).addTo(map);

    map.createPane("divisions"); map.getPane("divisions").style.zIndex = 410;
    map.createPane("markers");   map.getPane("markers").style.zIndex = 420;

    // Data state
    let divisionsFC = { type:"FeatureCollection", features:[] };
    let statesFC    = { type:"FeatureCollection", features:[] };
    let divisionsLayer = null;
    const markers   = L.layerGroup([], { pane:"markers" }).addTo(map);
    const bbox      = L.latLngBounds();
    const countsByDivision = new Map(); // divisionId -> count
    const countsByState    = new Map(); // stateName -> count

    // Load divisions + states
    try { divisionsFC = await loadDivisions(B2M.divisionsUrl, B2M.divObject || ""); }
    catch (e) { console.error("[B2M] divisions load error", e); }

    try { statesFC = await fetchJSON(B2M.statesUrl); }
    catch (e) { statesFC = { type:"FeatureCollection", features:[] }; }

    // Optional suburb index
    try { if (B2M.suburbLookup) suburbIndex = buildSuburbIndex(await fetchJSON(B2M.suburbLookup)); }
    catch (_) { suburbIndex = null; }

    // Draw regions (always visible)
    divisionsLayer = L.geoJSON(divisionsFC, {
      pane: "divisions",
      filter: f => ["Polygon","MultiPolygon"].includes(f?.geometry?.type),
      style: f => styleForCount(0),
      onEachFeature: (f, layer) => {
        const id = regionIdOf(f) || "(unknown)";
        layer.on({
          mouseover: () => layer.setStyle({ weight:2, color:"#71797E", fillOpacity:0.75, fillColor:getColor(countsByDivision.get(id)||0) }),
          mouseout:  () => layer.setStyle(styleForCount(countsByDivision.get(id)||0)),
          click:     () => {
            const c = countsByDivision.get(id) || 0;
            const st = regionStateOf(f) || "—";
            layer.bindTooltip(`<strong>${id}</strong><br/>State: ${st}<br/>${fmt(c)} report(s)`).openTooltip();
          }
        });
      }
    }).addTo(map);

    // CSV/XLSX load
    const rows = await loadCSVorXLSX(B2M.cioDataCsv, B2M.cioDataXlsx);

    // Helpers
    function addMarker(lat, lon, props) {
      L.circleMarker([lat,lon],{
        radius:5, weight:1, color:"#5b6b75", fillOpacity:0.85, fillColor:"#1f78b4"
      }).bindTooltip(() => {
        const lines=[];
        if (props.suburb) lines.push(`<strong>${props.suburb}</strong>`);
        if (props.state || props.postcode) lines.push([props.state,props.postcode].filter(Boolean).join(" "));
        if (props.division) lines.push(props.division);
        return lines.join("<br/>") || "Report";
      }).addTo(markers);
      bbox.extend([lat,lon]);
    }

    function assignToDivision(lat, lon, rowState){
      const pt = turf.point([lon,lat]);
      for (const f of divisionsFC.features) {
        try {
          if (turf.booleanPointInPolygon(pt, f)) {
            const divId = regionIdOf(f) || "(unknown)";
            const st    = regionStateOf(f) || rowState || "Unknown";
            countsByDivision.set(divId, (countsByDivision.get(divId)||0) + 1);
            countsByState.set(st, (countsByState.get(st)||0) + 1);
            return { division: divId, state: st };
          }
        } catch {}
      }
      return null;
    }

    function assignToState(lat, lon, rowState){
      if (!statesFC.features?.length) return { division:null, state: rowState || "Unassigned" };
      const pt = turf.point([lon,lat]);
      for (const f of statesFC.features) {
        try {
          if (turf.booleanPointInPolygon(pt, f)) {
            const p = f.properties || {};
            const st = p.STATE_NAME || p.name || p.State || p.STATE || rowState || "Unassigned";
            countsByState.set(st, (countsByState.get(st)||0) + 1);
            return { division:null, state: st };
          }
        } catch {}
      }
      const st = rowState || "Unassigned";
      countsByState.set(st, (countsByState.get(st)||0) + 1);
      return { division:null, state: st };
    }

    function repaintDivisions(){
      divisionsLayer.setStyle(f => styleForCount(countsByDivision.get(regionIdOf(f)) || 0));
    }

    // Process rows
    for (const r of rows) {
      let lat = getLat(r);
      let lon = getLon(r);
      const rowState  = getState(r);
      const rowSuburb = getSuburb(r);
      const rowPC     = getPC(r);

      // If no coords, try suburb/postcode lookup
      if ((Number.isNaN(lat) || Number.isNaN(lon) || lat===undefined || lon===undefined) && suburbIndex) {
        const hit = lookupCoords(rowState, rowSuburb, rowPC);
        if (hit && hit.length===2) { lon=parseFloat(hit[0]); lat=parseFloat(hit[1]); }
      }
      if (Number.isNaN(lat) || Number.isNaN(lon) || lat===undefined || lon===undefined) continue;

      // First try division PIP, else state PIP, else CSV state
      const inDiv = assignToDivision(lat, lon, rowState);
      const result = inDiv || assignToState(lat, lon, rowState);

      addMarker(lat, lon, { suburb: rowSuburb, state: result.state, postcode: rowPC, division: result.division });
    }

    // Final repaint & view
    repaintDivisions();
    if (bbox.isValid()) map.fitBounds(bbox.pad(0.15)); else map.fitBounds(AU_BOUNDS);

    // Keep styles consistent on zoom
    map.on("zoomend", repaintDivisions);
    setTimeout(() => map.invalidateSize(), 120);
  });
})();
