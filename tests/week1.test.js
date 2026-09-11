// Week 1 feature tests: honest booked-ahead labels, seats & utilisation, projection trust note, Reg 12 tile.
// Harness mirrors tests/phase0.test.js: temp DB via DB_PATH, fixture users, app.listen(0). Later batches append t.test blocks.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'pulse-week1-'));
process.env.DB_PATH=path.join(dir,'test.db');process.env.NODE_ENV='test';
process.env.ADMIN_EMAIL='test-admin@example.test';process.env.ADMIN_DEFAULT_PASSWORD='FixturePasswordOnly!';
process.env.SESSION_SECRET='fixture-session-only';process.env.ANTHROPIC_API_KEY='fixture';
const db=require('../db/db'), bcrypt=require('bcryptjs');
const pass='FixturePasswordOnly!';
for(const [id,name,cap,opening] of [['a','Centre Alpha',100,0],['b','Centre Beta',100,0],['open','Centre Opening',0,1]]) db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,?,?)').run(id,name,cap,opening);
for(const role of ['viewer','centre','exec','admin']) db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role+'@example.test',role,bcrypt.hashSync(pass,4),role,role==='centre'?'a':null);
const m=require('../services/metrics'), cal=require('../services/calendar');
const today=m.todayStr();
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const monthShift=(n)=>{const [y,mo]=today.slice(0,7).split('-').map(Number);return new Date(Date.UTC(y,mo-1+n,1)).toISOString().slice(0,7);};
const dm=db.prepare('INSERT INTO daily_metrics(owna_id,metric_date,capacity,booked,attended,absent,casual,fee_total) VALUES(?,?,100,?,?,?,?,?)');
// King's Birthday week 2026: Mon 8 June is a NSW public holiday — OWNA still carries a booking row (nobody attends).
dm.run('a','2026-06-08',30,0,30,0,600); dm.run('a','2026-06-09',50,45,5,1,1000); dm.run('a','2026-06-10',70,60,10,2,1400);
dm.run('b','2026-06-09',40,40,0,0,800);
// Today (attendance known) and a week ahead (future rows carry OWNA's default "attending" flag).
dm.run('a',today,50,40,10,1,1000); dm.run('a',addDays(today,7),60,60,0,3,1200);
// Incidents: current month, three months back and eleven months back are inside the 12-month window; twelve back is not.
const inc=db.prepare('INSERT INTO incidents_monthly(owna_id,month,total,injuries,illness,serious,reportable) VALUES(?,?,?,?,?,?,?)');
inc.run('a',monthShift(0),10,8,2,0,1); inc.run('a',monthShift(-3),20,15,5,1,2); inc.run('a',monthShift(-11),12,10,2,0,1); inc.run('a',monthShift(-12),30,20,10,2,5);
// Batch 2 fixtures: one finalised pay week (ending Sun 14 Jun 2026, King's Birthday week). Alpha/Beta map to OWNA centres;
// HQ has no owna_id and the pre-opening centre has no bookings, so neither can have a per-child-day figure.
const lw=db.prepare('INSERT INTO labour_weekly(eh_centre,week_ending,owna_id,employees,worked_h,worked_amt,kitchen_h,kitchen_amt,cleaning_h,cleaning_amt,leave_h,leave_amt,matwc_amt,casual_h) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
lw.run('Futuro Alpha','2026-06-14','a',10,300,9000,20,600,10,240,20,600,0,30);
lw.run('Futuro Beta','2026-06-14','b',5,100,3000,10,400,0,0,5,200,0,0);
lw.run('Futuro HQ','2026-06-14',null,3,80,5000,0,0,0,0,0,0,0,0);
lw.run('Futuro Opening','2026-06-14','open',1,20,1000,0,0,0,0,0,0,0,0);
const INC_FIX=[[monthShift(0),10,8,2,0,1],[monthShift(-3),20,15,5,1,2],[monthShift(-11),12,10,2,0,1],[monthShift(-12),30,20,10,2,5]];
const incSum=(from,to)=>INC_FIX.filter(f=>f[0]>=from&&f[0]<=to).reduce((a,f)=>({total:a.total+f[1],injuries:a.injuries+f[2],illness:a.illness+f[3],serious:a.serious+f[4],reportable:a.reportable+f[5],months:a.months+1}),{total:0,injuries:0,illness:0,serious:0,reportable:0,months:0});
const app=require('../server');
let server,base;
async function login(role){const r=await fetch(base+'/login',{method:'POST',body:new URLSearchParams({email:role+'@example.test',password:pass}),redirect:'manual'});assert.equal(r.status,302);return r.headers.get('set-cookie').split(';')[0];}
async function request(url,cookie){return fetch(base+url,{headers:{cookie},redirect:'manual'});}
async function page(url,cookie){const r=await request(url,cookie);assert.equal(r.status,200,url+' '+r.status);return r.text();}

test('Week 1 batch 1',async(t)=>{
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 try {
 await t.test('calendar counts NSW operating days',()=>{
  assert.equal(cal.operatingDays('2026-07-01','2027-06-30'),253); // FY2026-27: 261 weekdays − 8 weekday holidays
  assert.equal(cal.operatingDays('2026-01-01','2026-12-31'),253);
  assert.equal(cal.operatingDays('2026-06-08','2026-06-12'),4); // King's Birthday week
  assert.equal(cal.operatingDays('2026-09-12','2026-09-13'),0); // weekend
  assert.equal(cal.operatingDays('2026-09-11','2026-09-01'),0); // reversed range
  assert.equal(cal.isOperatingDay('2026-04-25'),false); // Anzac Day (Saturday)
  assert.equal(cal.isOperatingDay('2026-04-24'),true);
  assert.equal(cal.isOperatingDay('2026-10-05'),false); // Labour Day
  assert.deepEqual(cal.unknownHolidayYears('2024-06-01','2025-01-01'),[2024]);
  assert.deepEqual(cal.operatingDayList('2026-04-02','2026-04-07'),['2026-04-02','2026-04-07']); // Easter 2026
 });
 await t.test('yearStart / yearRange follow the 1 July financial year by default',()=>{
  assert.equal(m.yearStart('fy','2026-09-11'),'2026-07-01');
  assert.equal(m.yearStart('fy','2026-03-01'),'2025-07-01');
  assert.equal(m.yearStart('cy','2026-09-11'),'2026-01-01');
  assert.deepEqual(m.yearRange('fy','2026-09-11'),{kind:'fy',start:'2026-07-01',end:'2027-06-30',label:'FY2026-27',ytdLabel:'FYTD'});
  assert.deepEqual(m.yearRange('cy','2026-09-11'),{kind:'cy',start:'2026-01-01',end:'2026-12-31',label:'CY2026',ytdLabel:'CYTD'});
  assert.equal(m.yearRange('bogus','2026-09-11').kind,'fy');
 });
 await t.test('seatsFilled averages booked children over operating days only',()=>{
  const s=m.seatsFilled('2026-06-08','2026-06-12');
  assert.equal(s.operating_days,4);
  assert.deepEqual(s.rows.map(r=>[r.owna_id,r.booked,r.days,r.seats]),[['a',120,2,60],['b',40,1,40]]); // holiday row excluded
  assert.deepEqual(s.group,{booked:160,days:2,seats:80});
  assert.equal(s.byOwna.a.seats,60);
  assert.deepEqual(m.seatsFilled('2026-06-13','2026-06-14').group,{booked:0,days:0,seats:0});
 });
 await t.test('utilisationYtd divides operating-day bookings by places × operating days, with the annual denominator',()=>{
  const u=m.utilisationYtd('fy','2026-06-12');
  assert.equal(u.label,'FY2025-26');assert.equal(u.start,'2025-07-01');assert.equal(u.end,'2026-06-30');assert.equal(u.today,'2026-06-12');
  const opYtd=cal.operatingDays('2025-07-01','2026-06-12');
  assert.equal(u.operating_days_ytd,opYtd);assert.equal(u.operating_days_year,253);
  assert.equal(u.places,200); // pre-opening centre excluded
  assert.deepEqual(u.rows.map(r=>[r.owna_id,r.booked,r.cap_days,r.utilisation]),[['a',120,100*opYtd,m.pct(120,100*opYtd)],['b',40,100*opYtd,m.pct(40,100*opYtd)]]);
  assert.deepEqual(u.group,{booked:160,cap_days:200*opYtd,utilisation:m.pct(160,200*opYtd),capacity:200,annual_child_days:200*253});
  assert.equal(u.annual_child_days,50600);
  const c=m.utilisationYtd('cy','2026-06-12');assert.equal(c.label,'CY2026');assert.equal(c.start,'2026-01-01');assert.equal(c.operating_days_year,253);
 });
 await t.test('overview splits past and booked-ahead days; attendance is past days only',()=>{
  const row=m.overview(today,addDays(today,7)).find(r=>r.owna_id==='a');
  assert.equal(row.days,2);assert.equal(row.past_days,1);assert.equal(row.future_days,1);
  assert.equal(row.booked,110);assert.equal(row.past_booked,50);assert.equal(row.future_booked,60);
  assert.equal(row.attended,40);assert.equal(row.absent,10);assert.equal(row.attendance_rate,80);
  assert.equal(row.fee_total,2200);assert.equal(row.fee_past,1000);assert.equal(row.fee_future,1200);
  const t1=m.totals(m.overview(today,addDays(today,7)));
  assert.equal(t1.attendance_rate,80);assert.equal(t1.fee_future,1200);assert.equal(t1.past_days,1);assert.equal(t1.future_days,1);
  const t0=m.totals(m.overview(today,today));
  assert.equal(t0.attendance_rate,80);assert.equal(t0.fee_future,0);assert.equal(t0.future_days,0);assert.equal(t0.booked,50);
  assert.equal(m.totals([]).attendance_rate,0);
 });
 await t.test('reg12Last12Months sums reportable incidents over the 12 months to now',()=>{
  const r=m.reg12Last12Months('a');
  assert.equal(r.reportable,4);assert.equal(r.months,3);assert.equal(r.from_month,monthShift(-11));assert.equal(r.to_month,monthShift(0));
  assert.equal(r.first_month,monthShift(-11));assert.equal(r.last_month,monthShift(0));
  assert.deepEqual(m.reg12Last12Months('b'),{from_month:monthShift(-11),to_month:monthShift(0),reportable:0,serious:0,total:0,months:0,first_month:null,last_month:null});
  assert.equal(m.reg12Last12Months('a','2026-09-11').from_month,'2025-10');
 });
 await t.test('overview labels booked-ahead ranges honestly and shows seats and utilisation',async()=>{
  const c=await login('admin');
  const ahead=await page(`/?from=${today}&to=${addDays(today,7)}`,c);
  assert.match(ahead,/booked ahead — departures not yet deducted, so this overstates/);
  assert.match(ahead,/past days only/);
  assert.match(ahead,/Fees: billed to date \+ booked ahead/);
  assert.match(ahead,/\$1,000 billed to date · \$1,200 booked ahead/);
  assert.match(ahead,/Fees billed to date \+ booked ahead/); // table header
  assert.match(ahead,/Seats filled, avg per day/);
  assert.match(ahead,/Utilisation FYTD · FY/);
  assert.match(ahead,/Annual denominator FY\d{4}-\d{2} = \d+ operating days/);
  const past=await page(`/?from=${addDays(today,-6)}&to=${today}`,c);
  assert.doesNotMatch(past,/booked ahead/);
  assert.doesNotMatch(past,/past days only/);
  assert.match(past,/Fees billed/);
  assert.match(past,/Seats filled, avg per day/);
  const cy=await page(`/?from=${addDays(today,-6)}&to=${today}&year=cy`,c);
  assert.match(cy,/Utilisation CYTD · CY\d{4}/);
  assert.match(cy,/Showing calendar year/);
  // Seats over King's Birthday week: Alpha 60, Beta 40, group 80 (holiday booking row ignored).
  const kb=await page('/?from=2026-06-08&to=2026-06-12',c);
  assert.match(kb,/2 operating days with bookings/);
  assert.match(kb,/<td class="num">60<\/td>/);assert.match(kb,/<td class="num">40<\/td>/);assert.match(kb,/<td class="num">80<\/td>/);
  // Viewer (aggregates only) and centre-scoped logins render the same tiles for their scope.
  assert.match(await page('/',await login('viewer')),/Seats filled, avg per day/);
  const scoped=await page(`/?from=${today}&to=${addDays(today,7)}`,await login('centre'));
  assert.match(scoped,/booked ahead — departures not yet deducted/);assert.doesNotMatch(scoped,/Centre Beta/);
 });
 await t.test('projection is renamed, sits after the pipeline in the nav and carries the 90-day trust note',async()=>{
  const c=await login('exec');
  const html=await page('/projection',c);
  const iPipe=html.indexOf('>Enrolment Pipeline<'), iProj=html.indexOf('>Enrolment Projection<'), iExit=html.indexOf('>Exit Report<');
  assert.ok(iPipe>0&&iProj>iPipe&&iExit>iProj,'nav order pipeline → projection → exits');
  assert.doesNotMatch(html,/>Projection</);
  assert.match(html,/Trust the first 90 days\.<\/strong> Beyond that the line adds pipeline starts but never deducts departures, so it is a ceiling, not a forecast\./);
  assert.match(html,/next 90 days/);
  assert.match(html,/6 mo · ceiling/);
  assert.doesNotMatch(html,/Projected with pipeline \(ceiling\)/);
  const long=await page('/projection?days=180',c);
  assert.match(long,/next 180 days/);assert.match(long,/Projected with pipeline \(ceiling\)/);assert.match(long,/badge warn">ceiling/);
  assert.match(await page('/projection?days=999',c),/next 90 days/); // default stays 90
 });
 await t.test('Q&C shows the Reg 12 tile for the selected centre and links to Safety',async()=>{
  const c=await login('admin');
  const a=await page('/qc?owna=a',c);
  assert.match(a,/Serious incidents \(Reg 12\), last 12 months/);
  assert.match(a,/Emergency services attended or medical attention sought — the two Reg 12 tests\. Recorded from OWNA incident reports\./);
  assert.match(a,/reg12-stat"><div class="n">4<\/div>/);
  assert.match(a,/3 months of data/);
  assert.match(a,/href="\/safety"/);
  const b=await page('/qc?owna=b',c);
  assert.match(b,/reg12-stat"><div class="n">—<\/div>/);assert.match(b,/No incident data for this centre yet/);
  assert.match(await page('/qc',await login('centre')),/3 months of data/); // scoped to Alpha
  assert.equal((await request('/qc',await login('viewer'))).status,403);
 });
 // ===== Batch 2 (Day 2): safety totals + YTD + year choice, Department notifications, wages per child-day =====
 await t.test('incidentsReport carries year-to-date, last-12-month and window totals for the chosen reporting year',()=>{
  const fy=m.incidentsReport(null,12,null,'fy');
  const fyStart=m.yearStart('fy',today).slice(0,7);
  assert.equal(fy.year.kind,'fy');assert.equal(fy.ytd.kind,'fy');assert.equal(fy.ytd.start,m.yearStart('fy',today));
  assert.match(fy.ytd.ytdLabel,/^FY \d{4}-\d{2} to date$/);
  assert.equal(fy.ytd.from_month,fyStart);assert.equal(fy.ytd.to_month,monthShift(0));
  const eFy=incSum(fyStart,monthShift(0));
  assert.deepEqual(fy.ytd.group,eFy);
  assert.deepEqual(fy.ytd.rows,[{owna_id:'a',name:'Centre Alpha',...eFy}]);
  assert.deepEqual(fy.rows[0].ytd,fy.ytd.rows[0]);
  // Last 12 calendar months: the three fixture months inside the window, not the one twelve months back.
  assert.equal(fy.last12.from_month,monthShift(-11));assert.equal(fy.last12.to_month,monthShift(0));
  assert.deepEqual(fy.last12.group,{total:42,injuries:33,illness:9,serious:1,reportable:4,months:3});
  assert.deepEqual(fy.rows[0].last12,{owna_id:'a',name:'Centre Alpha',total:42,injuries:33,illness:9,serious:1,reportable:4,months:3});
  // Window totals = every displayed month (only four distinct months exist, so all four are shown).
  assert.deepEqual(fy.rows[0].window,{months:4,total:72,injuries:53,illness:19,serious:3,reportable:9});
  assert.deepEqual(fy.windowTotals,{months:4,total:72,injuries:53,illness:19,serious:3,reportable:9});
  // Calendar year.
  const cy=m.incidentsReport(null,12,null,'cy');
  const cyStart=m.yearStart('cy',today).slice(0,7);
  assert.equal(cy.ytd.kind,'cy');assert.equal(cy.ytd.from_month,cyStart);
  assert.match(cy.ytd.ytdLabel,/^\d{4} to date$/);assert.equal(cy.ytd.ytdLabel,cyStart.slice(0,4)+' to date');
  assert.deepEqual(cy.ytd.group,incSum(cyStart,monthShift(0)));
  // Explicit "today": FY2026-27 to date on 11 Sep 2026 runs Jul → Sep 2026; unknown year kinds fall back to FY.
  const fixed=m.incidentsReport(null,12,null,'fy','2026-09-11');
  assert.equal(fixed.ytd.ytdLabel,'FY 2026-27 to date');assert.equal(fixed.ytd.from_month,'2026-07');assert.equal(fixed.ytd.to_month,'2026-09');
  assert.equal(fixed.last12.from_month,'2025-10');
  assert.equal(m.incidentsReport(null,12,null,'cy','2026-09-11').ytd.ytdLabel,'2026 to date');
  assert.equal(m.incidentsReport(null,12,null,'bogus').ytd.kind,'fy');
  // Scoped to a centre without incidents: no rows, zero group.
  const none=m.incidentsReport('b',12,null,'fy');
  assert.deepEqual(none.rows,[]);assert.deepEqual(none.ytd.group,{total:0,injuries:0,illness:0,serious:0,reportable:0,months:0});
  // Existing shape is unchanged.
  assert.equal(fy.rows[0].name,'Centre Alpha');assert.equal(fy.headline.total,fy.totals.find(x=>x.month===fy.selectedMonth).total);
 });
 await t.test('Safety page shows Total columns, the YTD block in the warn colour, the FY / Calendar toggle and Department notifications',async()=>{
  const c=await login('admin');
  const html=await page('/safety',c);
  const eFy=incSum(m.yearStart('fy',today).slice(0,7),monthShift(0));
  assert.match(html,/FY \d{4}-\d{2} to date/);
  assert.match(html,new RegExp('<div class="n warn-text">'+eFy.total+'</div><div class="l">Total incident reports · FY \\d{4}-\\d{2} to date'));
  assert.match(html,new RegExp('class="ytd-total">'+eFy.total+'</td>'));
  assert.match(html,/<th style="text-align:right;">Total<\/th><th style="text-align:right;">Injuries<\/th>/); // monthly and YTD tables
  assert.match(html,/Total<br><span style="font-weight:400;text-transform:none;">4 mo<\/span>/); // trend grid total column
  assert.match(html,/border-left:2px solid var\(--line,#e5e7eb\);font-weight:700;">72<br>/);
  assert.match(html,/Notified to the Department · FY \d{4}-\d{2} to date/);
  assert.match(html,new RegExp('<div class="n">4</div><div class="l">Notified to the Department · last 12 months'));
  assert.match(html,/emergency services attended or medical attention sought, from OWNA incident reports/);
  assert.match(html,/OWNA does not expose a separate “notified” flag/);
  assert.match(html,/href="\/safety\?year=fy" class="on"/);assert.match(html,/href="\/safety\?year=cy" class=""/);
  assert.match(html,/>FY<\/a> \| <a href="\/safety\?year=cy"[^>]*>Calendar<\/a>/);
  assert.match(html,/<input type="hidden" name="year" value="fy">/);
  assert.doesNotMatch(html,/ to date · Jul \d{4} → Jul/); // sanity: label is the reporting year, not a month
  const cy=await page('/safety?year=cy',c);
  const eCy=incSum(m.yearStart('cy',today).slice(0,7),monthShift(0));
  assert.match(cy,new RegExp('<div class="n warn-text">'+eCy.total+'</div><div class="l">Total incident reports · \\d{4} to date'));
  assert.doesNotMatch(cy,/FY \d{4}-\d{2} to date/);
  assert.match(cy,/href="\/safety\?year=cy" class="on"/);assert.match(cy,/<input type="hidden" name="year" value="cy">/);
  // A chosen month survives the toggle links; the default month does not pin itself.
  const rep=m.incidentsReport(null,12,null,'fy');
  const other=rep.months.find(mm=>mm!==rep.lastComplete);
  assert.match(await page('/safety?month='+other,c),new RegExp('href="/safety\\?year=cy&amp;month='+other+'"'));
  assert.match(html,/href="\/safety\?year=cy"/);
  // Viewer (aggregates only) and centre-scoped users still open the page; no child, family or staff names are present.
  const v=await page('/safety',await login('viewer'));assert.match(v,/Notified to the Department/);assert.doesNotMatch(v,/child_name|family_name/);
  assert.match(await page('/safety?year=cy',await login('centre')),/\d{4} to date/);
 });
 await t.test('ownaWeek returns booked child-days on operating days and labourForWeek prices wages per child-day',()=>{
  // King's Birthday week: Alpha has booking rows Mon 8 (holiday, 30), Tue 9 (50), Wed 10 (70); Beta Tue 9 (40).
  assert.deepEqual(m.ownaWeek('a','2026-06-14'),{revenue:3000,occupancy:50,child_days:120,op_days:2});
  assert.deepEqual(m.ownaWeek('b','2026-06-14'),{revenue:800,occupancy:40,child_days:40,op_days:1});
  assert.deepEqual(m.ownaWeek(null,'2026-06-14'),{revenue:0,occupancy:null,child_days:0,op_days:0});
  assert.deepEqual(m.ownaWeek('open','2026-06-14'),{revenue:0,occupancy:null,child_days:0,op_days:0});
  assert.deepEqual(m.labourWeeks(16),['2026-06-14']);
  const rows=m.labourForWeek('2026-06-14');
  const by=Object.fromEntries(rows.map(r=>[r.eh_centre,r]));
  assert.equal(by['Futuro Alpha'].child_days,120);assert.equal(by['Futuro Alpha'].care_wages,9600);
  assert.equal(by['Futuro Alpha'].wages_per_child_day,80); // 9600 / 120
  assert.equal(by['Futuro Alpha'].all_in_per_child_day,87); // (9600 + 600 + 240) / 120
  assert.equal(by['Futuro Beta'].wages_per_child_day,80); // 3200 / 40
  assert.equal(by['Futuro Beta'].all_in_per_child_day,90); // (3200 + 400) / 40
  assert.equal(by['Futuro HQ'].child_days,0);assert.equal(by['Futuro HQ'].wages_per_child_day,null);assert.equal(by['Futuro HQ'].all_in_per_child_day,null);
  assert.equal(by['Futuro Opening'].wages_per_child_day,null);
  assert.deepEqual(m.wagesPerChildDay(rows),{centres:2,child_days:160,care_wages:12800,all_wages:14040,per_child_day:80,all_in_per_child_day:88});
  assert.deepEqual(m.wagesPerChildDay([]),{centres:0,child_days:0,care_wages:0,all_wages:0,per_child_day:null,all_in_per_child_day:null});
  // Existing fields are untouched.
  assert.equal(by['Futuro Alpha'].revenue,3000);assert.equal(by['Futuro Alpha'].wage_pct,320);assert.equal(by['Futuro HQ'].worked_amt,5000);
 });
 await t.test('Wages page shows per child-day columns, the total row, the group tile and the footnote',async()=>{
  const c=await login('admin');
  const html=await page('/wages?week=2026-06-14',c);
  assert.match(html,/<th class="num">Educator wages<br>per child-day<\/th>\s*<th class="num">All-in<br>per child-day<\/th>/);
  assert.match(html,/<td class="num">\$80<\/td>\s*<td class="num">\$87<\/td>/); // Alpha
  assert.match(html,/<td class="num">\$80<\/td>\s*<td class="num">\$90<\/td>/); // Beta
  assert.match(html,/<td class="num"><span class="muted">—<\/span><\/td>\s*<td class="num"><span class="muted">—<\/span><\/td>/); // HQ / pre-opening
  assert.match(html,/<td class="num">\$80<\/td>\s*<td class="num">\$88<\/td>\s*<td class="num">—<\/td>/); // total row
  assert.match(html,/<div class="n">\$80<\/div><div class="l">Wages per child-day<span class="cap">educator wages ÷ 160 booked child-days · all-in \$88<\/span>/);
  assert.match(html,/<strong>Wages per child-day<\/strong> = educator wages \(worked \+ leave \+ other\) ÷ booked child-days/);
  assert.doesNotMatch(html,/\$80\.\d/);
  assert.equal((await request('/wages',await login('centre'))).status,403); // still blocked for centre logins
 });
 } finally {await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
