#!/usr/bin/env node
/*
 * OWNA rostered shift vs actual centre sign-in/out, for one staff member. READ-ONLY.
 *
 * Roster source: OWNA `/api/roster/{centreId}/{anyDateInWeek}` returns the WHOLE week containing
 * that date — `weekstarting` (Monday) plus a `monday`..`sunday` array of shift entries, each with
 * local `start`/`end` as HH:MM. (Employment Hero also has /rostershift, but Heath Rd barely uses
 * it — 10 shifts for 2 people in a sample week — so OWNA is the roster of record.)
 *
 * Actual source: `/api/staff/log/{centreId}/{date}`, "centre checkin" / "centre checkout" only.
 * Room-level `signin` events are ignored here; this compares presence on site, not room movement.
 *
 * Usage: node scripts/owna-roster-vs-actual.js "<name or ftCode>" [centre] [days]
 *   e.g. node scripts/owna-roster-vs-actual.js "Rachael Perkins" heath 60
 */
require("dotenv").config();
const path=require("path");
const fs=require("fs");
const os=require("os");
const m=require(path.join(__dirname,"..","services","metrics"));

const OBASE=(process.env.OWNA_BASE_URL||"https://api.owna.com.au").replace(/\/$/,"");
const OKEY=process.env.OWNA_API_KEY||"";
const TZ="Australia/Sydney";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const fT=new Intl.DateTimeFormat("en-GB",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false});
const fD=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
const lt=(iso)=>fT.format(new Date(iso));
const ld=(iso)=>fD.format(new Date(iso));
const toMin=(hhmm)=>{const[a,b]=String(hhmm||"").split(":").map(Number);return Number.isFinite(a)?a*60+(b||0):null;};
const hhmm=(mins)=>`${String(Math.floor(mins/60)).padStart(2,"0")}:${String(mins%60).padStart(2,"0")}`;
const sign=(n)=>(n>0?"+":"")+n;
const ALIAS={heath:/heath/i,lhr:/heath/i,gwh:/gledswood/i,gledswood:/gledswood/i,austral:/austral/i,bardia:/bardia/i};
const DAYS=["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

async function oget(p,a=0){
  try{
    const r=await fetch(OBASE+p,{signal:AbortSignal.timeout(45000),headers:{"x-api-key":OKEY,Accept:"application/json"}});
    const t=await r.text();
    if(!r.ok){ if((r.status===429||r.status>=500)&&a<3){await sleep(600*2**a);return oget(p,a+1);} throw new Error(`OWNA ${r.status} ${p}`); }
    let b; try{b=JSON.parse(t);}catch{ throw new Error(`OWNA ${p}: non-JSON response (content filter?)`); }
    return Array.isArray(b)?b:(b.data||[]);
  }catch(e){ if(a<3&&/fetch failed|timeout/i.test(e.message)){await sleep(600*2**a);return oget(p,a+1);} throw e; }
}
async function staffAll(cid){const out=[];for(let skip=0;;){const rows=await oget(`/api/staff/${cid}/list?take=500&skip=${skip}`);out.push(...rows);skip+=rows.length;if(!rows.length||rows.length<500)break;}return out;}
const addD=(iso,n)=>{const d=new Date(iso+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const mondayOf=(iso)=>{const d=new Date(iso+"T00:00:00Z");const off=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-off);return d.toISOString().slice(0,10);};

(async()=>{
  const who=process.argv[2]||"";
  const centreArg=(process.argv[3]||"heath").toLowerCase();
  const days=Number(process.argv[4]||60);
  const al=ALIAS[centreArg];
  const centre=m.centres().find(c=>al?al.test(c.name):c.owna_id===centreArg);
  if(!centre){console.error("centre not matched");process.exit(1);}

  const staff=await staffAll(centre.owna_id);
  const rx=new RegExp(who.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i");
  const person=staff.find(s=>rx.test([s.firstname,s.surname].filter(Boolean).join(" "))||rx.test(String(s.employeeCode||"")));
  if(!person){console.error(`No staff matched "${who}" at ${centre.name}`);process.exit(1);}
  const NAME=[person.firstname,person.surname].filter(Boolean).join(" ");

  const to=fD.format(new Date()), from=addD(to,-(days-1));
  const dates=[];for(let d=from;d<=to;d=addD(d,1))dates.push(d);

  console.log("══════════════════════════════════════════════════════════════════════════════════");
  console.log(`  ${NAME} — rostered vs actual sign-in`);
  console.log(`  ${centre.name.replace(/.*- /,"")} · ${from} → ${to} (${dates.length} days) · ${TZ}`);
  console.log(`  OWNA staff id ${person.id} · employee code ${person.employeeCode||"(blank)"} · ${person.empType||"?"}`);
  console.log("══════════════════════════════════════════════════════════════════════════════════\n");

  // --- rosters, one fetch per week ---
  const weeks=[...new Set(dates.map(mondayOf))];
  const roster={}, leaveNotes={};
  for(const wk of weeks){
    let wkRows=[]; try{ wkRows=await oget(`/api/roster/${centre.owna_id}/${wk}`);}catch(e){ continue; }
    for(const w of wkRows){
      const ws=String(w.weekstarting||wk).slice(0,10);
      DAYS.forEach((dn,i)=>{
        const date=addD(ws,(i+6)%7);
        (w[dn]||[]).filter(x=>String(x.staffid)===String(person.id)).forEach(x=>{
          (roster[date]=roster[date]||[]).push({start:x.start,end:x.end,room:x.room,lunch:x.lunch});
        });
      });
      // Leave sits in its own array on the week document. `day` is 1-based from MONDAY
      // (verified: base 1 gives zero collisions with worked days and never lands on a weekend).
      if(Array.isArray(w.leave)) w.leave.filter(l=>String(l.staffId||l.staffid||"")===String(person.id))
        .forEach(l=>{ const date=addD(ws,Number(l.day)-1);
          leaveNotes[date]={type:l.leavetype||"Leave",hours:Number(l.hours||0)}; });
    }
  }

  // --- actuals ---
  const actual={};
  for(const d of dates){
    let log=[]; try{ log=await oget(`/api/staff/log/${centre.owna_id}/${d}`);}catch(e){ continue; }
    const mine=log.filter(r=>String(r.staffId)===String(person.id)&&/centre\s*check/i.test(r.status))
      .sort((a,b)=>new Date(a.statusDate)-new Date(b.statusDate));
    if(!mine.length) continue;
    const ins=mine.filter(r=>/checkin/i.test(r.status)), outs=mine.filter(r=>/checkout/i.test(r.status));
    if(!ins.length&&!outs.length) continue;
    actual[d]={first:ins[0]?lt(ins[0].statusDate):null,last:outs.length?lt(outs[outs.length-1].statusDate):null,taps:mine.length};
  }

  // --- compare ---
  const today=fD.format(new Date());
  const rows=[]; let nR=0,nA=0,both=0,sumRost=0,sumAct=0,lateN=0,earlyN=0,dStart=[],dEnd=[],leaveH=0,leaveD=0;
  for(const d of dates){
    const r=roster[d], a=actual[d], lv=leaveNotes[d];
    if(lv){leaveD++;leaveH+=lv.hours;}
    if(!r&&!a&&!lv) continue;
    const rs=r?toMin(r[0].start):null, re=r?toMin(r[r.length-1].end):null;
    const as=a&&a.first?toMin(a.first):null, ae=a&&a.last?toMin(a.last):null;
    const rh=(rs!=null&&re!=null)?(re-rs)/60:null;
    const ah=(as!=null&&ae!=null)?(ae-as)/60:null;
    // Compare only complete, non-leave days: today's shift is still open, and a leave day has
    // no shift to compare against even when the roster still carries one.
    const comparable = !lv && d!==today;
    if(r&&comparable){nR++; if(rh)sumRost+=rh;}
    if(a&&comparable){nA++; if(ah)sumAct+=ah;}
    let ds=null,de=null;
    if(rs!=null&&as!=null){ds=as-rs;if(comparable){dStart.push(ds);if(ds>5)lateN++;}}
    if(re!=null&&ae!=null){de=ae-re;if(comparable){dEnd.push(de);if(de<-5)earlyN++;}}
    if(r&&a&&comparable)both++;
    rows.push({d,r,rs,re,as,ae,rh,ah,ds,de,lv,comparable});
  }

  const wd=(d)=>["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(d+"T00:00:00Z").getUTCDay()];
  console.log("  Date        Day   Rostered      Actual        Start Δ  End Δ   Rost h  Act h   Note");
  console.log("  " + "─".repeat(96));
  for(const x of rows){
    const rost=x.r?`${x.r[0].start}-${x.r[x.r.length-1].end}`:"   —     ";
    const act=(x.as!=null||x.ae!=null)?`${x.as!=null?hhmm(x.as):"  ?  "}-${x.ae!=null?hhmm(x.ae):"  ?  "}`:"   —     ";
    let note="";
    if(x.lv) note=`on leave — ${x.lv.type} (${x.lv.hours}h)`+(x.r?" [still on roster]":"");
    else if(x.d===today) note="today, shift still open";
    else if(x.r&&!x.as&&!x.ae) note="ROSTERED, NO SIGN-IN";
    else if(!x.r&&(x.as!=null)) note="worked, not on roster";
    else if(x.as!=null&&x.ae==null) note="no check-out";
    console.log(`  ${x.d}  ${wd(x.d)}   ${rost.padEnd(13)} ${act.padEnd(13)} ${(x.ds!=null?sign(x.ds)+"m":"   —").padStart(7)} ${(x.de!=null?sign(x.de)+"m":"   —").padStart(6)} ${(x.rh!=null?x.rh.toFixed(2):"  — ").padStart(7)} ${(x.ah!=null?x.ah.toFixed(2):"  — ").padStart(6)}   ${note}`);
  }
  const med=(a)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
  const mean=(a)=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
  console.log("  " + "─".repeat(96));
  console.log(`\n  Comparable days (excludes leave and today): rostered ${nR} · signed in ${nA} · both ${both}`);
  console.log(`  On leave ${leaveD} day(s), ${leaveH.toFixed(1)} h — ` + (()=>{const t={};dates.forEach(d=>{const l=leaveNotes[d];if(l)t[l.type]=(t[l.type]||0)+l.hours;});return Object.entries(t).map(([k,v])=>`${k} ${v}h`).join(", ")||"n/a";})());
  console.log(`  Rostered hours ${sumRost.toFixed(1)} · actual on-site hours ${sumAct.toFixed(1)} · difference ${sign(+(sumAct-sumRost).toFixed(1))} h`);
  if(dStart.length) console.log(`  Start vs roster: median ${sign(med(dStart))} min, mean ${sign(Math.round(mean(dStart)))} min · later than rostered on ${lateN} of ${dStart.length} days`);
  if(dEnd.length)   console.log(`  End vs roster:   median ${sign(med(dEnd))} min, mean ${sign(Math.round(mean(dEnd)))} min · left early on ${earlyN} of ${dEnd.length} days`);
  const rNoA=rows.filter(x=>x.r&&x.as==null&&x.ae==null&&x.comparable), aNoR=rows.filter(x=>!x.r&&x.as!=null&&x.comparable);
  console.log(`  Rostered but no sign-in: ${rNoA.length}${rNoA.length?" ("+rNoA.map(x=>x.d).join(", ")+")":""}`);
  console.log(`  Signed in but not rostered: ${aNoR.length}${aNoR.length?" ("+aNoR.map(x=>x.d).join(", ")+")":""}`);


  const out=path.join(os.homedir(),"Desktop",`${NAME.toLowerCase().replace(/[^a-z0-9]+/g,"-")}-roster-vs-actual-${from}_to_${to}.csv`);
  const q=(v)=>`"${String(v==null?"":v).replace(/"/g,'""')}"`;
  fs.writeFileSync(out,["date,weekday,rostered_start,rostered_end,rostered_hours,actual_first_in,actual_last_out,actual_hours,start_delta_mins,end_delta_mins,leave_type,leave_hours,note"]
    .concat(rows.map(x=>[x.d,wd(x.d),x.r?x.r[0].start:"",x.r?x.r[x.r.length-1].end:"",x.rh!=null?x.rh.toFixed(2):"",
      x.as!=null?hhmm(x.as):"",x.ae!=null?hhmm(x.ae):"",x.ah!=null?x.ah.toFixed(2):"",x.ds!=null?x.ds:"",x.de!=null?x.de:"",
      x.lv?x.lv.type:"",x.lv?x.lv.hours:"",
      x.lv?"on leave":(x.d===today?"today, shift still open":(x.r&&x.as==null?"ROSTERED, NO SIGN-IN":(!x.r&&x.as!=null?"worked, not on roster":(x.as!=null&&x.ae==null?"no check-out":""))))].map(q).join(","))).join("\n"));
  console.log(`\n  CSV: ${path.basename(out)} (on your Desktop)`);
  console.log("\n  *** READ-ONLY — nothing was written to OWNA or Employment Hero. ***");
})().catch(e=>{console.error("Error:",e.message);process.exit(1);});
