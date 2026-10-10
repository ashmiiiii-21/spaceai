/* =========================================================================
   MISSION DATABASE
   Launch vehicles, propulsion systems, orbit classes, mission presets.
   Figures are approximate public values, rounded, for preliminary design.
   ========================================================================= */
var MP = window.MP || {};
window.MP = MP;

MP.CONST = {
  MU: 398600.4418,        // Earth GM, km^3/s^2
  RE: 6378.137,           // Earth radius, km
  J2: 1.08263e-3,
  G0: 9.80665,            // m/s^2
  SOLAR: 1361,            // W/m^2 at 1 AU
  YEAR: 3.15576e7,        // s
  OMEGA_SSO: 1.99106e-7,  // rad/s, required RAAN drift for sun-synchronous
  V_ROT_EQ: 0.4651,       // km/s, Earth rotation speed at equator
  MU_MOON: 4902.8, R_MOON: 1737.4, D_MOON: 384400,
  MU_MARS: 42828.4, R_MARS: 3389.5,
  MU_SUN: 1.32712e11, AU: 1.495979e8, A_MARS: 2.2794e8
};

/* Launch vehicles.
   leo / sso / gto are payload capacities (kg) used as anchor points of the
   capacity curve. sso is quoted for ~600 km SSO, leo for ~200 km at the site's
   natural inclination, gto for a standard 200 x 35,786 km transfer orbit.
   flights / ok are approximate launch records used for Bayesian reliability.
   injSigma is 1-sigma injection error the spacecraft must trim (m/s). */
MP.VEHICLES = [
  { id:'pslv',   name:'PSLV-XL',        provider:'ISRO',        country:'India',  site:'Sriharikota',     lat:13.72, gtoInc:18, leo:3800,  sso:1750, gto:1425, price:25,  flights:64,  ok:60,  injSigma:12, fairing:3.2 },
  { id:'gslv',   name:'GSLV Mk II',     provider:'ISRO',        country:'India',  site:'Sriharikota',     lat:13.72, gtoInc:19.2, leo:6000,  sso:3000, gto:2250, price:47,  flights:18,  ok:14,  injSigma:15, fairing:3.4 },
  { id:'lvm3',   name:'LVM3',           provider:'ISRO',        country:'India',  site:'Sriharikota',     lat:13.72, gtoInc:21.5, leo:10000, sso:5800, gto:4000, price:62,  flights:9,   ok:9,   injSigma:10, fairing:5.0 },
  { id:'sslv',   name:'SSLV',           provider:'ISRO',        country:'India',  site:'Sriharikota',     lat:13.72, leo:500,   sso:300,  gto:0,    price:4.5, flights:3,   ok:2,   injSigma:20, fairing:2.0 },
  { id:'f9',     name:'Falcon 9',       provider:'SpaceX',      country:'USA',    site:'Cape Canaveral',  lat:28.56, gtoInc:27, leo:17500, sso:12000,gto:5500, price:70,  flights:560, ok:557, injSigma:5,  fairing:5.2 },
  { id:'f9rs',   name:'Falcon 9 Rideshare', provider:'SpaceX',  country:'USA',    site:'Vandenberg',      lat:34.63, leo:0,     sso:800,  gto:0,    price:0,   flights:560, ok:557, injSigma:8,  fairing:5.2,
    rideshare:true, perKg:0.0065, minCharge:0.33, dropAlt:525 },
  { id:'electron', name:'Electron',     provider:'Rocket Lab',  country:'New Zealand', site:'Mahia',      lat:-39.26,leo:300,   sso:200,  gto:0,    price:8.5, flights:72,  ok:68,  injSigma:6,  fairing:1.2 },
  { id:'a6',     name:'Ariane 6 (A62)', provider:'Arianespace', country:'Europe', site:'Kourou',          lat:5.24,  leo:10300, sso:7200, gto:4500, price:85,  flights:6,   ok:6,   injSigma:6,  fairing:5.4 },
  { id:'vegac',  name:'Vega-C',         provider:'Arianespace', country:'Europe', site:'Kourou',          lat:5.24,  leo:3300,  sso:2300, gto:0,    price:45,  flights:5,   ok:4,   injSigma:10, fairing:3.3 },
  { id:'h3',     name:'H3-22',          provider:'JAXA / MHI',  country:'Japan',  site:'Tanegashima',     lat:30.40, gtoInc:28.5, leo:9000,  sso:4000, gto:4500, price:50,  flights:7,   ok:5,   injSigma:8,  fairing:5.2 }
];
MP.VEHICLES.forEach(function (v) { v.reliability = (v.ok + 1) / (v.flights + 2); });

MP.PROVIDERS = ['ISRO', 'SpaceX', 'Rocket Lab', 'Arianespace', 'JAXA / MHI'];

/* Spacecraft propulsion options */
MP.PROPULSION = [
  { id:'cold',  name:'Cold gas (N2)',          isp:65,   baseMass:2,  tankFrac:0.50, cost:0.2, pFail:0.004, maxDv:0.08, impulsive:true },
  { id:'mono',  name:'Monopropellant (N2H4)',  isp:220,  baseMass:6,  tankFrac:0.12, cost:1.2, pFail:0.008, maxDv:9,    impulsive:true },
  { id:'green', name:'Green monoprop (LMP-103S)', isp:245, baseMass:7, tankFrac:0.12, cost:1.8, pFail:0.010, maxDv:9,   impulsive:true },
  { id:'biprop',name:'Bipropellant (MMH/NTO)', isp:315,  baseMass:24, tankFrac:0.10, cost:4.0, pFail:0.014, maxDv:9,    impulsive:true },
  { id:'ep',    name:'Electric (Hall thruster)', isp:1500, baseMass:14, tankFrac:0.10, cost:5.0, pFail:0.020, maxDv:9, impulsive:false }
];

/* Orbit classes */
MP.ORBITS = {
  LEO:   { name:'Low Earth orbit',          short:'LEO',   env:0.8, degr:0.0275, dod:0.30, opsCost:1.0, altEditable:true,  incEditable:true,  altRange:[300,1500],   flex:true },
  SSO:   { name:'Sun-synchronous orbit',    short:'SSO',   env:0.9, degr:0.0275, dod:0.30, opsCost:1.0, altEditable:true,  incEditable:false, altRange:[400,1000],   flex:true },
  MEO:   { name:'Medium Earth orbit',       short:'MEO',   env:1.4, degr:0.045,  dod:0.50, opsCost:1.0, altEditable:true,  incEditable:true,  altRange:[8000,25000], flex:false },
  GEO:   { name:'Geostationary orbit',      short:'GEO',   env:1.0, degr:0.020,  dod:0.70, opsCost:1.0, altEditable:false, incEditable:false, altRange:[35786,35786], flex:false },
  LUNAR: { name:'Low lunar orbit',          short:'Lunar', env:1.2, degr:0.025,  dod:0.50, opsCost:2.5, altEditable:true,  incEditable:false, altRange:[50,500],     flex:false },
  MARS:  { name:'Mars orbit (elliptical)',  short:'Mars',  env:1.3, degr:0.020,  dod:0.50, opsCost:4.0, altEditable:false, incEditable:false, altRange:[0,0],        flex:false }
};

MP.MISSION_TYPES = {
  eo:    { name:'Earth observation',   costMult:1.10 },
  comms: { name:'Communication',       costMult:1.00 },
  nav:   { name:'Navigation',          costMult:1.20 },
  sci:   { name:'Science',             costMult:1.30 },
  tech:  { name:'Technology demo',     costMult:0.55 },
  explore:{ name:'Planetary exploration', costMult:1.50 }
};

/* Sample missions. Shown in the app as samples, not as real programmes. */
MP.PRESETS = [
  { id:'eo',   label:'Earth observation smallsat',   type:'eo',    orbit:'SSO',  alt:550,   inc:97.6, flex:50, payload:180, power:220,  life:5,  budget:90,  minP:0.85 },
  { id:'cube', label:'CubeSat technology demo',      type:'tech',  orbit:'SSO',  alt:525,   inc:97.5, flex:30, payload:6,   power:20,   life:2,  budget:12,  minP:0.70 },
  { id:'geo',  label:'GEO communication satellite',  type:'comms', orbit:'GEO',  alt:35786, inc:0,    flex:0,  payload:900, power:3500, life:15, budget:560, minP:0.75 },
  { id:'nav',  label:'Navigation satellite (MEO)',   type:'nav',   orbit:'MEO',  alt:20200, inc:55,   flex:0,  payload:600, power:900,  life:12, budget:380, minP:0.85 },
  { id:'leo',  label:'LEO science observatory',      type:'sci',   orbit:'LEO',  alt:600,   inc:30,   flex:50, payload:700, power:900,  life:4,  budget:350, minP:0.85 },
  { id:'moon', label:'Lunar orbiter',                type:'explore', orbit:'LUNAR', alt:100, inc:90,  flex:0,  payload:120, power:300,  life:2,  budget:240, minP:0.75 },
  { id:'mars', label:'Mars orbiter',                 type:'explore', orbit:'MARS',  alt:0,   inc:0,   flex:0,  payload:50,  power:200,  life:2,  budget:380, minP:0.70 }
];

/* Exponential atmosphere (Vallado), base altitude km, density kg/m^3, scale height km */
MP.ATMOS = [
  [150,2.070e-9,22.523],[180,5.464e-10,29.740],[200,2.789e-10,37.105],[250,7.248e-11,45.546],
  [300,2.418e-11,53.628],[350,9.518e-12,53.298],[400,3.725e-12,58.515],[450,1.585e-12,60.828],
  [500,6.967e-13,63.822],[600,1.454e-13,71.835],[700,3.614e-14,88.667],[800,1.170e-14,124.64],
  [900,5.245e-15,181.05],[1000,3.019e-15,268.00]
];
MP.SOLAR_ACTIVITY = { low:0.5, moderate:1.0, high:2.5 };
