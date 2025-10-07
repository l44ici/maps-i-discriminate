/* ===== Back2Maps — one bubble per CSV row + regional choropleth (bubbles on top) ===== */
(() => {
  "use strict";

  // ---- Prevent jQuery crash
  if (window.jQuery && !jQuery.fn.progressbar)
    jQuery.fn.progressbar = function() { return this; };

  const CFG = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID = "b2m-map";
  const DIV_ZOOM = +(CFG.minZoomForDiv || 6);
  const STATES_URL  = CFG.statesUrl;
  const REGIONS_URL = CFG.divisionsUrl;
  const CSV_URL     = CFG.cioDataCsv;
  const SUBURBS_URL = CFG.suburbLookup;
  const AU_BOUNDS = [[-44,112],[-10,154]];
  const AU_CLAMP_BOUNDS =[[-47, 108], [-8, 159]];
  const LOG = (...a)=>console.log("[B2M]",...a);

  const fetchJSON = u => fetch(u).then(r=>r.ok?r.json():null).catch(()=>null);
  const fetchText = u => fetch(u).then(r=>r.ok?r.text():"").catch(()=>"");

  const STS=new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState=s=>{const x=(s??"").toString().trim().toUpperCase();return STS.has(x)?x:"";};
  const asPostcode=s=>{const x=(s??"").toString().replace(/\s+/g,"");return/^\d{4}$/.test(x)?x:"";};
  const clean=s=>(s??"").toString().toLowerCase().replace(/[^a-z0-9]/g,"");

  function parseCSVSafe(txt){
    if(!txt)return[];
    const lines=txt.split(/\r?\n/).filter(l=>l.trim().length);
    const header=lines.shift().split(",").map(h=>h.trim());
    return lines.map(line=>{
      const o={},cells=line.split(",");
      for(let i=0;i<header.length;i++)o[header[i]]=(cells[i]??"").trim();
      return o;
    });
  }

  const styleStates={color:"#fff",weight:1,fillColor:"#f4ebdf",fillOpacity:1};
  const styleRegionsInit={color:"#fff",weight:0.8,fillOpacity:0.2,fillColor:"#FDE68A"};
  const pointStyle={radius:6,fillColor:"#d93b2b",color:"#a11e14",weight:0.5,fillOpacity:0.75,opacity:0.35};

  function buildSuburbIndexes(suburbs){
    const byPC={},bySubState={};
    for(const r of suburbs){
      const pc=asPostcode(r.postcode),st=asState(r.state),sub=clean(r.suburb);
      const lat=+r.lat,lon=+r.lng;
      if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;
      if(pc&&!byPC[pc])byPC[pc]=[lat,lon];
      if(st&&sub&&!bySubState[`${st}|${sub}`])bySubState[`${st}|${sub}`]=[lat,lon];
    }
    LOG("Suburb index sizes:",Object.keys(byPC).length,Object.keys(bySubState).length);
    return{byPC,bySubState};
  }
  function rowToLatLon(r,keys,idx){
    const pc=asPostcode(r[keys.pc]);
    if(pc&&idx.byPC[pc])return idx.byPC[pc];
    const st=asState(r[keys.state]),sb=clean(r[keys.suburb]);
    if(st&&sb&&idx.bySubState[`${st}|${sb}`])return idx.bySubState[`${st}|${sb}`];
    return null;
  }

  function ensureRegionIds(fc){
    let i=0;
    for(const f of fc.features){
      const p=f.properties||{};
      p._b2m_id=p._b2m_id||p.SA4_NAME||p.SA3_NAME||p.REGION_NAME||p.name||`region_${++i}`;
      f.properties=p;
    }
  }

  function pointInPoly(pt,geom){
    const [x,y]=pt,chk=poly=>{
      let inside=false;
      for(const ring of poly){
        for(let i=0,j=ring.length-1;i<ring.length;j=i++){
          const [xi,yi]=ring[i],[xj,yj]=ring[j];
          const inter=(yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/((yj-yi)||1e-9)+xi;
          if(inter)inside=!inside;
        }
      }return inside;
    };
    if(geom.type==="Polygon")return chk(geom.coordinates);
    if(geom.type==="MultiPolygon")return geom.coordinates.some(chk);
    return false;
  }

  const DIV_COUNTS=new Map();
  const PALETTE=["#FEF3C7","#FDE68A","#F59E0B","#EA580C","#B91C1C"];
  let BREAKS=[];
  const quantiles=v=>{
    if(!v.length)return[];
    const s=v.slice().sort((a,b)=>a-b);
    return[0.2,0.4,0.6,0.8].map(q=>s[Math.floor(q*(s.length-1))]);
  };
  const colorForCount=n=>{
    if(!n)return"#ffffff";
    let i=0;while(i<BREAKS.length&&n>BREAKS[i])i++;
    return PALETTE[i];
  };

  function recolorRegions(layer){
    layer.eachLayer(l=>{
      const id=l.feature.properties._b2m_id;
      const n=DIV_COUNTS.get(id)||0;
      l.setStyle({color:"#fff",weight:0.8,fillOpacity:0.65,fillColor:colorForCount(n)});
    });
  }

  async function buildMap(){
    if(typeof L==="undefined"){console.error("[B2M] Leaflet missing");return;}

    const map=L.map('b2m-map',{zoomControl:true,minZoom:4,maxZoom:6, maxBounds: AU_CLAMP_BOUNDS, maxBoundsViscosity: 1.0, worldCopyJump: false, intertia: false});
    map.fitBounds(AU_BOUNDS);

    const [states,regions]=await Promise.all([fetchJSON(STATES_URL),fetchJSON(REGIONS_URL)]);
    if(states?.features)L.geoJSON(states,{style:styleStates}).addTo(map);
    if(!regions?.features)return console.error("[B2M] No region data");

    ensureRegionIds(regions);
    const regionLayer=L.geoJSON(regions,{style:styleRegionsInit}).addTo(map);
    const bubbles=L.layerGroup().addTo(map);

    const txt=await fetchText(SUBURBS_URL);
    let suburbs;try{suburbs=JSON.parse(txt).data||[];}catch{console.warn("[B2M] suburbs JSON fail");return;}
    const idx=buildSuburbIndexes(suburbs);
    const rows=parseCSVSafe(await fetchText(CSV_URL));
    if(!rows.length)return;

    const sample=rows[0];
    const keys={
      state:Object.keys(sample).find(k=>/state/i.test(k))||"",
      suburb:Object.keys(sample).find(k=>/suburb|town|city/i.test(k))||"",
      pc:Object.keys(sample).find(k=>/post.?code|zip/i.test(k))||""
    };

    let plotted=0;
    for(const r of rows){
      const ll=rowToLatLon(r,keys,idx);
      if(!ll)continue;
      const [lat,lon]=ll;
      L.circleMarker([lat,lon],pointStyle,)
        .addTo(bubbles);
      plotted++;
      
      for(const f of regions.features){
        if(pointInPoly([lon,lat],f.geometry)){
          const id=f.properties._b2m_id;
          DIV_COUNTS.set(id,(DIV_COUNTS.get(id)||0)+1);
          break;
        }
      }
    }

    const vals=[...DIV_COUNTS.values()].filter(v=>v>0);
    if(vals.length){
      BREAKS=quantiles(vals);
      recolorRegions(regionLayer);
    }

    bubbles.bringToFront();
    LOG("Plotted:",plotted,"Divisions:",DIV_COUNTS.size);
  }

  document.addEventListener("DOMContentLoaded",buildMap);
})();
