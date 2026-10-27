import { GEO } from './nyc-geodata.js';

// Utrecht spatial adapter for mrdoob/slop-newyork's engine, via the irregular-city data path of the Slop Berlin / Warsaw forks.
// Legacy export names are retained as API aliases; all visible geography is Utrecht.
// 1 unit = 1 metre, x east, z south, origin at the Domtoren (true north up).
const BERLIN_DATA = GEO.berlin;
const toPts = (flat) => { const out=[]; for(let i=0;i<flat.length;i+=2)out.push({x:flat[i],z:flat[i+1]});return out; };
const AFF = BERLIN_DATA.meta.lonLatAffine;
// Equirectangular fit around the Domtoren (meta.lonLatAffine): enough for teleports.
const projectLonLat = (lon,lat) => { const a=lon-AFF.lon0, b=lat-AFF.lat0; return {x:AFF.x[0]+AFF.x[1]*a+AFF.x[2]*b, z:AFF.z[0]+AFF.z[1]*a+AFF.z[2]*b}; };
const [minX,minZ,maxX,maxZ] = BERLIN_DATA.meta.bounds;
const ISLAND_BOUNDS = {minX,maxX,minZ,maxZ,sidewalkHeight:0.22,waterLevel:-2.2};
const CUT_Z=minZ;
const MANHATTAN_COASTLINE=toPts(GEO.manhattan);
const getIslandBoundsAtZ=()=>({westX:minX,eastX:maxX});
// Mitte has an arbitrary mapped street network. Empty legacy grid registries prevent
// the original corridor builder from inventing axis-aligned Manhattan streets.
const AVENUES=[], ALL_AVENUES=[], STREETS=[], ALL_STREETS=[];
const BROADWAY_LINE=[];
const getBroadwayX=()=>0;
const WATERFRONT_PIERS=[], EAST_RIVER_BRIDGES=[], OUTER_BRIDGES=[];
const ROOSEVELT_ISLAND_POLYGON=[],GOVERNORS_ISLAND_POLYGON=[],NJ_SHORELINE_POLYGON=[],LONG_ISLAND_POLYGON=[],LONG_ISLAND_POLYGONS=[],BROOKLYN_POLYGONS=[],QUEENS_POLYGONS=[],BRONX_POLYGONS=[],WESTCHESTER_POLYGON=[],NASSAU_POLYGON=[],UPPER_MANHATTAN_POLYGON=[],BRONX_POLYGON=[],STATEN_ISLAND_POLYGON=[],RANDALLS_ISLAND_POLYGON=[],LIBERTY_ISLAND_POLYGON=[],ELLIS_ISLAND_POLYGON=[],MILL_ROCK_POLYGON=[];
const LIBERTY_STATUE_POS={x:0,z:0};
// The legacy park bounds describe a raised Central Park lawn: Utrecht has none.
const CENTRAL_PARK_BOUNDS={minX:-99999,maxX:-99998,minZ:-99999,maxZ:-99998};
const ROADS=BERLIN_DATA.roads.filter(r=>!r.tunnel).map(r=>({...r,raw:r.name,name:r.name||`Unnamed ${r.kind}`,w:r.width,dir:r.oneway?(r.reverse?-1:1):0,highway:/motorway|trunk/.test(r.kind),pts:toPts(r.pts)}));
const DRIVABLE=new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street']);
const ROAD_DRIVING=ROADS.filter(r=>DRIVABLE.has(r.kind));
const BERLIN_AREAS=(BERLIN_DATA.meta.areas||[]).map(a=>({...a,polygons:(a.polygons||[]).map(p=>({
 poly:toPts(p.ring),holes:(p.holes||[]).map(toPts)
}))}));
function districtAt(x,z){
 if(x<-700)return 'stationsgebied';
 if(z<-600)return 'wittevrouwen';
 if(z>500)return 'museumkwartier';
 return 'binnenstad';
}
function makeBlock(b,id,park=0){
 const poly=toPts(b.ring),holes=(b.holes||[]).map(toPts);
 let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,a=0,cx=0,cz=0;
 for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  const p=poly[i],q=poly[j],c=q.x*p.z-p.x*q.z;
  minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);a+=c;cx+=(q.x+p.x)*c;cz+=(q.z+p.z)*c;
 }
 a*=.5;cx=a?cx/(6*a):(minX+maxX)/2;cz=a?cz/(6*a):(minZ+maxZ)/2;
 return {id,osmId:b.id,poly,holes,rects:[],frames:null,park,parkName:park?b.name:'',rect:false,area:Math.abs(a),minX,maxX,minZ,maxZ,cx,cz,median:false,district:districtAt(cx,cz)};
}
const BLOCKS=[...BERLIN_DATA.buildings.filter(b=>!b.part).map((b,i)=>makeBlock(b,i)),...BERLIN_DATA.parks.map((b,i)=>makeBlock(b,'park:'+i,1))];
const LANDMARK_BLOCKS=new Set();
const LANDMARK_SITES=GEO.landmarks;
function getBlockBounds(col,row){return BLOCKS[Number.isInteger(col)?col:0]||{minX:0,maxX:0,minZ:0,maxZ:0,cx:0,cz:0,width:0,depth:0};}
const avenueNameAt=(a)=>a?.short||a?.name||'';
const avenueX=()=>0;
const fromOldFrame=(x,z)=>({x,z});
// Nearest-road index (labels, sidewalk tests): uniform grid of road segments
const ROAD_CELL = 64;
const ROAD_GRID = new Map();
for (const r of ROADS) {
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const a = r.pts[i];
    const b = r.pts[i + 1];
    const seg = { r, ax: a.x, az: a.z, bx: b.x, bz: b.z };
    const ix0 = Math.floor(Math.min(a.x, b.x) / ROAD_CELL), ix1 = Math.floor(Math.max(a.x, b.x) / ROAD_CELL);
    const iz0 = Math.floor(Math.min(a.z, b.z) / ROAD_CELL), iz1 = Math.floor(Math.max(a.z, b.z) / ROAD_CELL);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const k = ix * 100000 + iz;
      if (!ROAD_GRID.has(k)) ROAD_GRID.set(k, []);
      ROAD_GRID.get(k).push(seg);
    }
  }
}
/** Nearest roads to (x, z) within `radius`: [{ road, dist }] sorted by distance (one entry per road name) */
function nearestRoads(x, z, radius = 60) {
  const best = new Map();
  const ix0 = Math.floor((x - radius) / ROAD_CELL), ix1 = Math.floor((x + radius) / ROAD_CELL);
  const iz0 = Math.floor((z - radius) / ROAD_CELL), iz1 = Math.floor((z + radius) / ROAD_CELL);
  for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
    const list = ROAD_GRID.get(ix * 100000 + iz);
    if (!list) continue;
    for (const s of list) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / L2));
      const d = Math.hypot(s.ax + t * dx - x, s.az + t * dz - z);
      if (d > radius) continue;
      const prev = best.get(s.r.name);
      if (!prev || d < prev.dist) best.set(s.r.name, { road: s.r, dist: d, horizontal: Math.abs(dx) > Math.abs(dz) });
    }
  }
  return [...best.values()].sort((a, b) => a.dist - b.dist);
}

// Spatial index of the blocks (64 m cells)
const BLOCK_CELL = 64;
const BLOCK_GRID = new Map();
for (const b of BLOCKS) {
  for (let ix = Math.floor(b.minX / BLOCK_CELL); ix <= Math.floor(b.maxX / BLOCK_CELL); ix++) {
    for (let iz = Math.floor(b.minZ / BLOCK_CELL); iz <= Math.floor(b.maxZ / BLOCK_CELL); iz++) {
      const k = ix * 100000 + iz;
      if (!BLOCK_GRID.has(k)) BLOCK_GRID.set(k, []);
      BLOCK_GRID.get(k).push(b);
    }
  }
}
function pointInPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
/** The block (curb island) under (x, z), or null on the roadway / in the water */
function blockAt(x, z) {
  const list = BLOCK_GRID.get(Math.floor(x / BLOCK_CELL) * 100000 + Math.floor(z / BLOCK_CELL));
  for (const b of list || []) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if ((b.rect || pointInPoly(b.poly, x, z)) && !b.holes.some(h=>pointInPoly(h,x,z))) return b;
  }
  return sidewalkAt(x,z);
}
function sidewalkAt(x,z){
  if(waterAt(x,z)&&!nearestRoads(x,z,24).some(q=>q.road.bridge&&q.dist<q.road.w/2+3))return null;
  for(const q of nearestRoads(x,z,24)){
    const r=q.road, pedestrian=['footway','pedestrian','path','cycleway','steps'].includes(r.kind);
    if((pedestrian&&q.dist<=r.w/2)||(!pedestrian&&q.dist>=r.w/2-.4&&q.dist<=r.w/2+5.5))return {id:'sidewalk:'+r.id,sidewalk:true,park:0,median:false,cx:x,cz:z,district:districtAt(x,z)};
  }
  return null;
}


const WATER_POLYGONS=BERLIN_DATA.water.map(w=>{const poly=toPts(w.ring);return {...w,poly,inner:(w.holes||[]).map(toPts),minX:Math.min(...poly.map(p=>p.x)),maxX:Math.max(...poly.map(p=>p.x)),minZ:Math.min(...poly.map(p=>p.z)),maxZ:Math.max(...poly.map(p=>p.z))};});
function waterAtExact(x,z){return WATER_POLYGONS.some(w=>x>=w.minX&&x<=w.maxX&&z>=w.minZ&&z<=w.maxZ&&pointInPoly(w.poly,x,z)&&!w.inner.some(h=>pointInPoly(h,x,z)));}
// The Oudegracht and the singels are mapped water polygons, and traffic calls waterAt many times per frame.
// A 4 m grid (scanline even-odd fill) answers inside/outside; only cells crossed by a shoreline use the exact test.
const WATER_CELL=4, WNX=Math.ceil((maxX-minX)/WATER_CELL), WNZ=Math.ceil((maxZ-minZ)/WATER_CELL);
const WATER_GRID=new Uint8Array(WNX*WNZ);
{
 const rings=[];for(const w of WATER_POLYGONS){rings.push(w.poly,...w.inner);}
 const xs=[];
 for(let j=0;j<WNZ;j++){
  const zc=minZ+(j+.5)*WATER_CELL;xs.length=0;
  for(const r of rings)for(let i=0,k=r.length-1;i<r.length;k=i++){const a=r[i],b=r[k];if((a.z>zc)!==(b.z>zc))xs.push(a.x+(zc-a.z)*(b.x-a.x)/(b.z-a.z));}
  xs.sort((p,q)=>p-q);
  for(let t=0;t+1<xs.length;t+=2){const i0=Math.max(0,Math.ceil((xs[t]-minX)/WATER_CELL-.5)),i1=Math.min(WNX-1,Math.floor((xs[t+1]-minX)/WATER_CELL-.5));for(let i=i0;i<=i1;i++)WATER_GRID[j*WNX+i]=1;}
 }
 for(const r of rings)for(let i=0,k=r.length-1;i<r.length;k=i++){
  const a=r[i],b=r[k],n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/1));
  for(let t=0;t<=n;t++){const x=a.x+(b.x-a.x)*t/n,z=a.z+(b.z-a.z)*t/n;
   for(const [dx,dz] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]){const gi=Math.floor((x-minX)/WATER_CELL)+dx,gj=Math.floor((z-minZ)/WATER_CELL)+dz;if(gi>=0&&gj>=0&&gi<WNX&&gj<WNZ)WATER_GRID[gj*WNX+gi]=2;}}
 }
}
function waterAt(x,z){
 const gi=Math.floor((x-minX)/WATER_CELL),gj=Math.floor((z-minZ)/WATER_CELL);
 if(gi<0||gj<0||gi>=WNX||gj>=WNZ)return waterAtExact(x,z);
 const v=WATER_GRID[gj*WNX+gi];return v===2?waterAtExact(x,z):v===1;
}
function nearestDrivingPoint(x,z,name=null){
 let best=null,dist=Infinity;
 for(const r of ROAD_DRIVING.filter(r=>!name||r.name===name))for(let i=0;i+1<r.pts.length;i++){
  const a=r.pts[i],b=r.pts[i+1],dx=b.x-a.x,dz=b.z-a.z,L2=dx*dx+dz*dz;if(L2<1)continue;
  const t=Math.max(0.02,Math.min(.98,((x-a.x)*dx+(z-a.z)*dz)/L2)),px=a.x+t*dx,pz=a.z+t*dz,d=Math.hypot(px-x,pz-z);
  if(d<dist){dist=d;const sign=r.dir<0?-1:1;best={x:px,z:pz,heading:Math.atan2(dx*sign,dz*sign),road:r};}
 }
 return best;
}
function arrival(lon,lat,name=null){const p=projectLonLat(lon,lat),q=nearestDrivingPoint(p.x,p.z,name);return q?{x:q.x,z:q.z,heading:q.heading}:{...p,heading:0};}
const defaultSpawn=arrival(5.1243,52.0885,'Lange Nieuwstraat');
defaultSpawn.x-=Math.cos(defaultSpawn.heading)*1.8;defaultSpawn.z+=Math.sin(defaultSpawn.heading)*1.8;defaultSpawn.name='Lange Nieuwstraat';
// Legacy material code samples ordered district bands through streetZ; keep distinct thresholds.
const streetZ=(n=37)=>defaultSpawn.z+(37-Number(n))*25;
const NYC_LANDMARKS=[
 ['dom','Domtoren','Domtoren',5.12139,52.09062,'Binnenstad','Korte Nieuwstraat'],
 ['centraal','Utrecht Centraal','Centraal',5.1100,52.0894,'Stationsgebied','Stationsplein'],
 ['hoogcatharijne','Hoog Catharijne','Hoog Catharijne',5.1130,52.0905,'Stationsgebied','Catharijnesingel'],
 ['stadhuis','Stadhuis','Stadhuis',5.1195,52.0919,'Binnenstad','Stadhuisbrug'],
 ['vredenburg','TivoliVredenburg','Vredenburg',5.1148,52.0929,'Binnenstad','Vredenburg'],
 ['neude','Neude','Neude',5.1163,52.0950,'Binnenstad','Neude'],
 ['janskerkhof','Janskerkhof','Janskerkhof',5.1244,52.0944,'Binnenstad','Janskerkhof'],
 ['oudegracht','Oudegracht · Werven','Oudegracht',5.1186,52.0903,'Binnenstad','Oudegracht'],
 ['centraalmuseum','Centraal Museum','Centraal Museum',5.1264,52.0869,'Museumkwartier','Agnietenstraat'],
].map(([id,name,short,lon,lat,district,road])=>({id,name,short,...projectLonLat(lon,lat),district,road,lon,lat}));
const TELEPORT_LOCATIONS={};
for(const lm of NYC_LANDMARKS){
 const p=arrival(lm.lon,lm.lat,lm.road);
 TELEPORT_LOCATIONS[lm.id]=Math.hypot(p.x-lm.x,p.z-lm.z)<400?p:arrival(lm.lon,lm.lat);
 const t=TELEPORT_LOCATIONS[lm.id];t.heading=Math.atan2(lm.x-t.x,lm.z-t.z);
}
for(const lm of NYC_LANDMARKS)if(!LANDMARK_SITES[lm.name])LANDMARK_SITES[lm.name]={x:lm.x,z:lm.z,w:60,d:60,h:20,ring:[]};
function getLocationLabel(x,z){
 for(const lm of NYC_LANDMARKS)if(Math.hypot(x-lm.x,z-lm.z)<100)return lm.name;
 const nearby=nearestRoads(x,z,100).filter(q=>q.road.raw);
 if(nearby.length>1&&nearby[1].dist<22)return `${nearby[0].road.name} & ${nearby[1].road.name}`;
 if(nearby.length)return nearby[0].road.name;
 if(waterAt(x,z))return 'Singel · Utrecht';
 const district=districtAt(x,z);
 const name=BERLIN_AREAS.find(a=>a.id===district)?.name||district.split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ');
 return name+' · Utrecht';
}
// Keyboard shortcuts are ignored while typing into a form field (e.g. the map's street search box)
function isTypingInField(e) {
  return e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
}

// Traffic signal cycle shared by the signal heads (street-details.js) and the traffic (traffic.js), in seconds:
// avenues green until avenueAmber, amber until avenueRed; cross streets green from avenueRed until streetAmber,
// amber until the end of the cycle. Pedestrians cross with the traffic that runs parallel to them, stepping off
// only on the WALK, the first `walk` seconds of its green: long enough before the cross traffic's green for the
// slowest walker to get across the widest avenue.
const SIGNAL_TIMING = { cycle: 60, avenueAmber: 26, avenueRed: 30, streetAmber: 56, walk: 7 };

// 'green', 'amber' or 'red' for avenue or cross street traffic at a given time
function signalPhase(time, isAvenue) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const t = ((time % cycle) + cycle) % cycle;
  if (isAvenue) return t < avenueAmber ? 'green' : t < avenueRed ? 'amber' : 'red';
  return t < avenueRed ? 'red' : t < streetAmber ? 'green' : 'amber';
}

// Do pedestrians walking alongside avenue (or cross street) traffic have the WALK at a given time?
function walkSignal(time, isAvenue) {
  const { cycle, avenueRed, walk } = SIGNAL_TIMING;
  const t = (((time - (isAvenue ? 0 : avenueRed)) % cycle) + cycle) % cycle;
  return t < walk;
}
export {
  BERLIN_DATA, BERLIN_AREAS, toPts, projectLonLat, pointInPoly, waterAt, waterAtExact, nearestDrivingPoint, defaultSpawn, sidewalkAt,
  AVENUES,
  ALL_AVENUES,
  CENTRAL_PARK_BOUNDS,
  getIslandBoundsAtZ,
  MANHATTAN_COASTLINE,
  getBroadwayX,
  BROADWAY_LINE,
  WATERFRONT_PIERS,
  ROOSEVELT_ISLAND_POLYGON,
  GOVERNORS_ISLAND_POLYGON,
  NJ_SHORELINE_POLYGON,
  LONG_ISLAND_POLYGONS,
  BROOKLYN_POLYGONS,
  QUEENS_POLYGONS,
  BRONX_POLYGONS,
  WESTCHESTER_POLYGON,
  NASSAU_POLYGON,
  UPPER_MANHATTAN_POLYGON,
  BRONX_POLYGON,
  STATEN_ISLAND_POLYGON,
  RANDALLS_ISLAND_POLYGON,
  LIBERTY_ISLAND_POLYGON,
  LIBERTY_STATUE_POS,
  ELLIS_ISLAND_POLYGON,
  MILL_ROCK_POLYGON,
  EAST_RIVER_BRIDGES,
  OUTER_BRIDGES,
  STREETS,
  ALL_STREETS,
  ROADS,
  NYC_LANDMARKS,
  LANDMARK_SITES,
  TELEPORT_LOCATIONS,
  ISLAND_BOUNDS,
  BLOCKS,
  CUT_Z,
  SIGNAL_TIMING,
  streetZ,
  avenueX,
  districtAt,
  blockAt,
  nearestRoads,
  getBlockBounds,
  getLocationLabel,
  fromOldFrame,
  isTypingInField,
  signalPhase,
  walkSignal
};
