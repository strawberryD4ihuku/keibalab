(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RaceCourse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // JRA公式コース平面図・コースデータをもとにした簡略俯瞰形状。
  // points はゴール板を起点に、右回り方向へ並べた正規化座標。
  const SHAPES = {
    round: [[.77,.76],[.45,.78],[.20,.70],[.09,.54],[.12,.33],[.31,.19],[.64,.17],[.86,.29],[.92,.52],[.88,.68]],
    compact: [[.78,.76],[.42,.78],[.18,.69],[.10,.51],[.15,.31],[.36,.19],[.70,.20],[.89,.34],[.91,.56],[.87,.69]],
    long: [[.79,.76],[.36,.77],[.13,.67],[.09,.48],[.18,.27],[.39,.18],[.78,.20],[.92,.34],[.91,.58],[.87,.69]],
    triangle: [[.76,.77],[.43,.79],[.18,.70],[.10,.53],[.18,.29],[.48,.14],[.80,.25],[.91,.46],[.88,.66]],
    asymmetric: [[.78,.76],[.42,.78],[.17,.70],[.09,.52],[.16,.29],[.43,.17],[.77,.22],[.92,.39],[.89,.61]],
    outer: [[.80,.76],[.33,.77],[.10,.65],[.08,.43],[.21,.24],[.48,.16],[.83,.23],[.93,.43],[.88,.66]],
  };

  const COURSES = {
    '札幌': {direction:'right', turf:{lap:1640.9,straight:266.1,shape:'round'}, dirt:{lap:1487,straight:264.3,shape:'round'}},
    '函館': {direction:'right', turf:{lap:1626.6,straight:262.1,shape:'compact'}, dirt:{lap:1475.8,straight:260.3,shape:'compact'}},
    '福島': {direction:'right', turf:{lap:1600,straight:292,shape:'compact'}, dirt:{lap:1444.6,straight:295.7,shape:'compact'}},
    '新潟': {direction:'left', turf:{lap:2223,straight:658.7,shape:'long',variant:'外回り'}, dirt:{lap:1472.5,straight:353.9,shape:'long'}},
    '東京': {direction:'left', turf:{lap:2083.1,straight:525.9,shape:'long'}, dirt:{lap:1899,straight:501.6,shape:'long'}},
    '中山': {direction:'right', turf:{lap:1667.1,straight:310,shape:'triangle',variant:'内回り'}, dirt:{lap:1493,straight:308,shape:'triangle'}},
    '中京': {direction:'left', turf:{lap:1705.9,straight:412.5,shape:'asymmetric'}, dirt:{lap:1530,straight:410.7,shape:'asymmetric'}},
    '京都': {direction:'right', turf:{lap:1894.3,straight:403.7,shape:'outer',variant:'外回り'}, dirt:{lap:1607.6,straight:329.1,shape:'compact'}},
    '阪神': {direction:'right', turf:{lap:2089,straight:473.6,shape:'outer',variant:'外回り'}, dirt:{lap:1517.6,straight:352.7,shape:'asymmetric'}},
    '小倉': {direction:'right', turf:{lap:1615.1,straight:293,shape:'compact'}, dirt:{lap:1445.4,straight:291.3,shape:'compact'}},
  };

  function getProfile(venue, surface, distance) {
    const base = COURSES[venue] || COURSES['東京'];
    const isDirt = surface === 'ダ';
    const profile = {...(isDirt ? base.dirt : base.turf)};
    const d = Number(distance) || 1600;

    if (!isDirt && venue === '新潟') {
      if (d === 1000) return {venue, surface:'芝', direction:'left', lap:1000, straight:1000, shape:'straight', variant:'直線'};
      if ([1200, 2200, 2400].includes(d)) Object.assign(profile, {lap:1623, straight:358.7, shape:'compact', variant:'内回り'});
    }
    if (!isDirt && venue === '中山' && [1200, 1600, 2200].includes(d)) {
      Object.assign(profile, {lap:1839.7, straight:310, shape:'outer', variant:'外回り'});
    }
    if (!isDirt && venue === '京都' && [1100, 1200, 2000].includes(d)) {
      Object.assign(profile, {lap:1782.8, straight:328.4, shape:'compact', variant:'内回り'});
    }
    if (!isDirt && venue === '阪神' && [1200, 1400, 2000, 2200, 3000].includes(d)) {
      Object.assign(profile, {lap:1689, straight:356.5, shape:'compact', variant:'内回り'});
    }
    return {venue: COURSES[venue] ? venue : '東京', surface: isDirt ? 'ダート' : '芝', direction:base.direction, ...profile};
  }

  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return {
      x: .5 * ((2*p1.x) + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 + (-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
      y: .5 * ((2*p1.y) + (-p0.y+p2.y)*t + (2*p0.y-5*p1.y+4*p2.y-p3.y)*t2 + (-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
    };
  }

  function buildPath(profile, width, height) {
    if (profile.shape === 'straight') {
      const points = [{x:width*.08,y:height*.55},{x:width*.92,y:height*.45}];
      const len = Math.hypot(points[1].x-points[0].x, points[1].y-points[0].y);
      return {points, cumulative:[0,len], total:len, straight:true};
    }
    const anchors = SHAPES[profile.shape] || SHAPES.long;
    const ps = anchors.map(([x,y]) => ({x:x*width,y:y*height}));
    const out = [];
    const steps = 18;
    for (let i = 0; i < ps.length; i++) {
      const p0 = ps[(i-1+ps.length)%ps.length], p1=ps[i], p2=ps[(i+1)%ps.length], p3=ps[(i+2)%ps.length];
      for (let s = 0; s < steps; s++) out.push(catmull(p0,p1,p2,p3,s/steps));
    }
    out.push({...out[0]});
    const cumulative = [0];
    for (let i=1;i<out.length;i++) cumulative.push(cumulative[i-1]+Math.hypot(out[i].x-out[i-1].x,out[i].y-out[i-1].y));
    return {points:out,cumulative,total:cumulative[cumulative.length-1],straight:false};
  }

  function pointAt(path, fraction) {
    const f = path.straight ? Math.max(0,Math.min(1,fraction)) : ((fraction%1)+1)%1;
    const target = f * path.total;
    let lo=0, hi=path.cumulative.length-1;
    while (lo<hi) { const mid=(lo+hi)>>1; if (path.cumulative[mid]<target) lo=mid+1; else hi=mid; }
    const i=Math.max(1,lo), a=path.points[i-1], b=path.points[i];
    const seg=path.cumulative[i]-path.cumulative[i-1] || 1;
    const t=(target-path.cumulative[i-1])/seg;
    const x=a.x+(b.x-a.x)*t, y=a.y+(b.y-a.y)*t;
    const mag=Math.hypot(b.x-a.x,b.y-a.y)||1;
    return {x,y,tx:(b.x-a.x)/mag,ty:(b.y-a.y)/mag,nx:-(b.y-a.y)/mag,ny:(b.x-a.x)/mag};
  }

  const TURF_TIMES = [[1000,57],[1200,69.5],[1400,81.5],[1600,94],[1800,106.5],[2000,119.5],[2200,132.5],[2400,145],[2600,158],[3000,182],[3200,195]];
  const DIRT_TIMES = [[1000,60],[1200,73],[1400,86],[1600,99],[1700,105.5],[1800,112.5],[2000,125.5],[2100,132],[2400,152]];

  function interpolate(table, distance) {
    const d=Number(distance)||1600;
    if (d<=table[0][0]) return table[0][1]*d/table[0][0];
    for(let i=1;i<table.length;i++) if(d<=table[i][0]) {
      const [d0,t0]=table[i-1],[d1,t1]=table[i], r=(d-d0)/(d1-d0);
      return t0+(t1-t0)*r;
    }
    const [d0,t0]=table[table.length-1];
    return t0+(d-d0)*(t0/d0);
  }

  function estimateFinishSeconds(distance, surface, pace, venue, condition) {
    let sec=interpolate(surface==='ダ'?DIRT_TIMES:TURF_TIMES,distance);
    const paceFactor=pace==='slow'?1.018:pace==='high'?.992:1;
    const venueFactor={'東京':1.004,'中山':1.006,'中京':1.005,'函館':1.006,'札幌':1.004,'小倉':.996,'新潟':.995}[venue]||1;
    // 芝は含水で時計が掛かる。ダートは適度に湿ると速くなる傾向を簡略化して反映。
    const conditionFactors = surface === 'ダ'
      ? {'良':1,'稍重':.992,'重':.986,'不良':.997}
      : {'良':1,'稍重':1.015,'重':1.035,'不良':1.055};
    return sec*paceFactor*venueFactor*(conditionFactors[condition]||1);
  }

  function formatTime(seconds) {
    const s=Math.max(0,Number(seconds)||0), m=Math.floor(s/60), rest=(s-m*60).toFixed(1).padStart(4,'0');
    return m ? `${m}:${rest}` : `${rest}秒`;
  }

  return {COURSES, getProfile, buildPath, pointAt, estimateFinishSeconds, formatTime};
});
