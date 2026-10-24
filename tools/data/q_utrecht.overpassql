[out:json][timeout:240];
(
  way["building"](52.0800,5.1000,52.1000,5.1400);
  relation["building"](52.0800,5.1000,52.1000,5.1400);
  way["building:part"](52.0800,5.1000,52.1000,5.1400);
  way["highway"](52.0800,5.1000,52.1000,5.1400);
  way["railway"~"^(rail|light_rail|tram|subway)$"](52.0800,5.1000,52.1000,5.1400);
  way["natural"="water"](52.0800,5.1000,52.1000,5.1400);
  relation["natural"="water"](52.0800,5.1000,52.1000,5.1400);
  way["waterway"~"^(river|canal|riverbank|dock)$"](52.0800,5.1000,52.1000,5.1400);
  way["leisure"~"^(park|garden|playground|pitch)$"](52.0800,5.1000,52.1000,5.1400);
  way["landuse"~"^(grass|recreation_ground|cemetery|village_green)$"](52.0800,5.1000,52.1000,5.1400);
  node["natural"="tree"](52.0800,5.1000,52.1000,5.1400);
  node["highway"="traffic_signals"](52.0800,5.1000,52.1000,5.1400);
);
out geom;
