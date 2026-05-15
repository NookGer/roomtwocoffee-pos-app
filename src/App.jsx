import { useState, useCallback, useRef, useEffect, useMemo, memo } from "react";
import { QRCodeSVG, QRCodeCanvas } from "qrcode.react";
import {
  DndContext, closestCenter, PointerSensor, TouchSensor,
  useSensor, useSensors
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy, useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ── PromptPay QR generator — EMVCo standard (PromptPay Thailand) ──
function generatePromptPayQR(phoneOrId, amount) {
  const raw = phoneOrId.replace(/[^0-9]/g,"");
  let target;
  if (raw.length === 13) {
    target = raw; // เลขบัตรประชาชน
  } else {
    // เบอร์โทร: 08xxxxxxxx → 668xxxxxxxx (ต้องตัด 0 ออก แล้วเติม 66)
    target = "0066" + raw.slice(1);  // 0847253855 → 0066847253855 (13 หลัก มาตรฐาน EMVCo)
  }
  const f = (id, val) => id + String(val.length).padStart(2,"0") + val;
  const guid = "A000000677010111";
  const mobileTag = raw.length === 13 ? "02" : "01";
  const merchantInfo = f("00", guid) + f(mobileTag, target);
  const amountStr = amount.toFixed(2);
  const body = f("00","01") + f("01","12") + f("29", merchantInfo) + f("53","764") + f("54", amountStr) + f("58","TH") + "6304";
  let crc = 0xFFFF;
  for (const c of body) {
    crc ^= c.charCodeAt(0) << 8;
    for (let j=0; j<8; j++) crc = (crc&0x8000)?((crc<<1)^0x1021)&0xFFFF:(crc<<1)&0xFFFF;
  }
  return body + crc.toString(16).toUpperCase().padStart(4,"0");
}

import {
  Coffee, Pencil, Trash2, Plus, X, ShoppingCart, BarChart2,
  GripVertical, AlertTriangle, Camera, CalendarDays, RefreshCw,
  Ban, Receipt, ChevronDown, ChevronUp, ImageDown, BookOpen,
  Settings, RotateCcw, CheckCircle, Download, Eye, Tag,
  Wallet, ArrowDownCircle, ArrowUpCircle, Undo2, PiggyBank,
  History, Gift, Percent
} from "lucide-react";

const SB_URL = "https://ejbggtfgmbfvaaatjmmo.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqYmdndGZnbWJmdmFhYXRqbW1vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0ODE1OTksImV4cCI6MjA5NDA1NzU5OX0.1Giv3iHq3xgwJsjGr5hlvnr1lVRu6z8xDNTIKVJie6w";

async function sbUpsert(payload) {
  try {
    const ts = new Date().toISOString();
    await fetch(`${SB_URL}/rest/v1/pos_snapshots`, {
      method: "POST",
      headers: { "Content-Type":"application/json","apikey":SB_KEY,"Authorization":`Bearer ${SB_KEY}`,"Prefer":"resolution=merge-duplicates" },
      body: JSON.stringify({ id:"main", data:payload, updated_at:ts }),
    });
    return ts; // คืน timestamp ที่ส่งไปจริงๆ
  } catch(e) { console.warn("sb upsert failed",e); return null; }
}
async function sbFetch() {
  // ดึง updated_at มาด้วยเพื่อใช้เปรียบเทียบ timestamp
  const r = await fetch(`${SB_URL}/rest/v1/pos_snapshots?id=eq.main&select=data,updated_at`, { headers:{"apikey":SB_KEY,"Authorization":`Bearer ${SB_KEY}`} });
  if(!r.ok) throw new Error(await r.text());
  const rows = await r.json();
  if(!rows[0]) return null;
  // คืน data พร้อม updated_at จาก Supabase row
  return { ...rows[0].data, _sbUpdatedAt: rows[0].updated_at };
}

// ── Storage keys (v10) ──
const SK_DATA="rt10_data", SK_RCPT="rt10_rcpt", SK_SYNC="rt10_sync";
const SK_LDGR="rt10_ldgr", SK_COST="rt10_cost", SK_CTOF="rt10_ctof", SK_SEQ="rt10_seq";

// ── Defaults ──
// NEW DATA SHAPE:
//  data.addons    [{id,name,price}]                        — บวกราคา
//  data.freeOpts  [{id,groupName,options:[{id,label}]}]    — ไม่คิดเงิน
//  data.discounts [{id,name,amount}]                       — หักราคา
//  product.linkedAddons    [addonId]
//  product.linkedFreeOpts  [freeOptGroupId]
//  product.linkedDiscounts [discountId]
const DEF_RCPT = { shopName:"RoomTwo Coffee", staffName:"", thankMsg:"ขอบคุณที่ใช้บริการ 🙏", logo:null, address:"", contact:"", promptpay:"", accountName:"" };
const DEF_DATA = {
  categories:[ {id:"cat_gen",name:"ทั่วไป",color:"#6B4F3A",order:0} ],
  products:[], addons:[], freeOpts:[], discounts:[], orders:[],
};
const DEF_CASH = { capital:0, profit:0 };

// ── Helpers ──
function ls_get(k,d){ try{ const r=localStorage.getItem(k); return r?JSON.parse(r):d; }catch(e){return d;} }
function ls_set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
function getNextOrderNum(date){ const s=ls_get(SK_SEQ,{date:"",count:0}); const n=s.date===date?s.count+1:1; ls_set(SK_SEQ,{date,count:n}); return n; }
function peekOrderNum(date){ const s=ls_get(SK_SEQ,{date:"",count:0}); return s.date===date?s.count+1:1; }
function fmtNum(n){ return "#"+String(n).padStart(3,"0"); }

const PALETTE=[
  // โทนเข้ม (เดิม)
  "#6B4F3A","#4A7C6B","#7C6B4A","#8B6B4A","#4A6B7C","#7C4A6B",
  "#6B7C4A","#7C4A4A","#4A4A7C","#C87941","#41967C","#7941C8",
  "#C84179","#4179C8","#79C841","#C8A841",
  // โทนกลาง
  "#E8724A","#4A9EE8","#E84A9E","#9EE84A","#E8C44A","#4AE8C4",
  // พาสเทล/โทนอ่อน
  "#F4A7B9","#A7C4F4","#A7F4C4","#F4E4A7","#C4A7F4","#F4C4A7",
  "#F4A7E4","#A7E4F4","#D4F4A7","#F4D4A7","#A7F4D4","#F4A7D4",
];
const MAX_ORDERS=40000;
function todayStr(){ return new Date().toISOString().split("T")[0]; }
function fmtDate(s){ return new Date(s+"T00:00:00").toLocaleDateString("th-TH",{weekday:"short",day:"numeric",month:"short",year:"numeric"}); }
function fmtDateS(s){ return new Date(s+"T00:00:00").toLocaleDateString("th-TH",{day:"numeric",month:"short"}); }
function fmtTime(s){ return new Date(s).toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit"}); }
function fmtDT(s){ return new Date(s).toLocaleString("th-TH",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}); }
function baht(n){ return "฿"+Number(n||0).toLocaleString("th-TH"); }
function uid(){ return Math.random().toString(36).slice(2,9); }
function reindex(arr){ return arr.map((x,i)=>({...x,order:i})); }
function dateBadge(d){ const t=todayStr(); if(d===t)return null; return d<t?{label:"ย้อนหลัง",bg:"#C87941"}:{label:"ล่วงหน้า",bg:"#4179C8"}; }
function computeCash(ledger){
  let capital=0,profit=0;
  [...ledger].sort((a,b)=>new Date(a.ts)-new Date(b.ts)).forEach(e=>{
    if(e.type==="initial"){ capital=e.capital||0; profit=e.profit||0; }
    if(e.type==="category"){ capital+=(e.cost||0); profit+=(e.netProfit||0); }
    if(e.type==="expense"){ capital-=(e.amount||0); }
    if(e.type==="withdrawal"){ profit-=(e.amount||0); }
  });
  return { capital, profit, total:capital+profit };
}
const iStyle={width:"100%",padding:"9px 12px",borderRadius:9,border:"1px solid #D4C4B0",fontSize:14,background:"#F5F0EA",color:"#2C1810",outline:"none",fontFamily:"inherit"};

// ══════════════════════════════════════════════════
// ROOT APP
// ══════════════════════════════════════════════════
export default function App() {
  // Inject Mali font globally
  useEffect(()=>{
    const link=document.createElement("link");
    link.rel="stylesheet";
    link.href="https://fonts.googleapis.com/css2?family=Mali:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap";
    document.head.appendChild(link);
    const style=document.createElement("style");
    style.textContent="*,*::before,*::after{font-family:'Mali',cursive!important;}";
    document.head.appendChild(style);
    return()=>{ document.head.removeChild(link); document.head.removeChild(style); };
  },[]);
  const [data,setData]     = useState(()=>{ const d=ls_get(SK_DATA,DEF_DATA); if(!d.addons)d.addons=[]; if(!d.freeOpts)d.freeOpts=[]; if(!d.discounts)d.discounts=[]; return d; });
  const [rcpt,setRcptSt]   = useState(()=>ls_get(SK_RCPT,DEF_RCPT));
  const [ledger,setLedger] = useState(()=>ls_get(SK_LDGR,[]));
  const [costs,setCosts]   = useState(()=>ls_get(SK_COST,{}));
  const [ctof,setCtof]     = useState(()=>ls_get(SK_CTOF,{}));
  const [syncSt,setSyncSt] = useState(()=>({status:navigator.onLine?"synced":"offline",...ls_get(SK_SYNC,{lastSynced:null})}));
  const [activeCat,setActive]=useState(null);
  const [cart,setCart]     = useState([]);
  const [modal,setModal]   = useState(null);
  const [dispDate,setDD]   = useState(todayStr);
  const [pendDate,setPend] = useState(null);
  const [view,setView]     = useState("pos");
  const [nextNum,setNN]    = useState(()=>peekOrderNum(todayStr()));
  // isRestoring: ล็อค UI ขณะดึงข้อมูลจาก Supabase ป้องกัน user แก้ไขก่อนข้อมูลพร้อม
  const [isRestoring,setIsRestoring] = useState(()=>!localStorage.getItem(SK_DATA)&&navigator.onLine);

  const cash = computeCash(ledger);

  useEffect(()=>{
    const s=data.categories.slice().sort((a,b)=>a.order-b.order);
    if(s.length&&!s.find(c=>c.id===activeCat)) setActive(s[0].id);
  },[data.categories]);

  // ── Dirty Flag ──
  // isDirty = true เฉพาะเมื่อ user กระทำจริง
  // บันทึกลง localStorage ด้วย เผื่อปิดแอปก่อน sync เสร็จ
  const isDirty = useRef(false);

  // โหลด dirty flag จาก localStorage ตอนเปิดแอป
  // ถ้าเคยมีข้อมูลค้างอยู่ก่อนปิดแอป → พร้อม sync ทันทีที่มี action ถัดไป
  useEffect(()=>{
    if(localStorage.getItem("rt10_dirty")==="1"){
      isDirty.current=true;
    }
  },[]);

  useEffect(()=>{
    // Online handler: เมื่อกลับมา online ให้เปรียบเทียบ timestamp ก่อนตัดสินใจ
    const on=async()=>{
      setSyncSt(s=>({...s,status:"synced"}));
      // ถ้า user เคยทำงาน offline มา (isDirty=true) ต้องเช็คก่อนว่า
      // Supabase มีข้อมูลใหม่กว่า local หรือเปล่า
      if(isDirty.current){
        try{
          const snap=await sbFetch();
          if(snap){
            const sbTs=snap.data?.lastSynced||snap.updated_at||"";
            const localTs=ls_get(SK_SYNC,{lastSynced:null}).lastSynced||"";
            if(sbTs&&localTs&&sbTs>localTs){
              // Supabase ใหม่กว่า → แจ้งเตือน user ให้เลือก
              setModal({type:"conflict",sbTs,localTs});
            }
            // ถ้า local ใหม่กว่า หรือเท่ากัน → upload ต่อตามปกติ (isDirty จะจัดการเอง)
          }
        }catch(e){ /* ถ้า fetch ไม่ได้ก็ข้ามไป */ }
      }
    };
    const off=()=>setSyncSt(s=>({...s,status:"offline"}));
    window.addEventListener("online",on);
    window.addEventListener("offline",off);
    return()=>{ window.removeEventListener("online",on); window.removeEventListener("offline",off); };
  },[]);

  // Auto-restore: ถ้าไม่มีข้อมูลในเครื่องเลย ดึงจาก Supabase อัตโนมัติ
  useEffect(()=>{
    if(!localStorage.getItem(SK_DATA)&&navigator.onLine){
      handleRestore();
    } else {
      setIsRestoring(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── debounce timer สำหรับ syncUp ──
  // ไม่ sync ทุก keystroke แต่รอให้หยุดพิมพ์ 1.5 วินาทีก่อน
  const syncTimer=useRef(null);

  const syncUp=useCallback((d,l,cs,ct,r)=>{
    if(!navigator.onLine)return;
    if(!isDirty.current)return;
    if(window.location.hostname==="localhost"||window.location.hostname==="127.0.0.1"){
      console.warn("🚫 syncUp blocked: DEV mode");
      return;
    }
    // debounce: ยกเลิก timer เดิม แล้วรอ 1.5s ก่อน sync จริง
    if(syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current=setTimeout(()=>{
      setSyncSt(s=>({...s,status:"syncing"}));
      sbUpsert({data:d,ledger:l.slice(-MAX_ORDERS),costs:cs,ctof:ct,rcpt:r})
        .then(ts=>{
          const finalTs=ts||new Date().toISOString();
          setSyncSt({status:"synced",lastSynced:finalTs});
          ls_set(SK_SYNC,{lastSynced:finalTs});
          // sync สำเร็จ → ล้าง dirty flag ทั้ง ref และ localStorage
          isDirty.current=false;
          localStorage.removeItem("rt10_dirty");
        })
        .catch(()=>setSyncSt(s=>({...s,status:"error"})));
    },1500);
  },[]);

  const persist=useCallback((nd,nl,ncs,nct,sync)=>{
    const d=nd??data, l=nl??ledger, cs=ncs??costs, ct=nct??ctof;

    // ── Rolling Window (ทำเฉพาะเมื่อมี orders เกิน 400 วัน) ──
    // ตรวจแค่ครั้งแรกกับครั้งที่ orders เปลี่ยน ไม่คำนวณทุก render
    let finalOrders=d.orders||[];
    let finalLedger=l||[];
    if(finalOrders.length>0){
      const today=new Date();
      const daysAgo=(n)=>{ const x=new Date(today); x.setDate(x.getDate()-n); return x.toISOString().split("T")[0]; };
      const cutoff400=daysAgo(400);
      const cutoff300=daysAgo(300);
      const sorted=finalOrders.slice().sort((a,b)=>new Date(a.ts)-new Date(b.ts));
      const oldestDate=sorted[0]?.date||sorted[0]?.ts?.split("T")[0]||"";
      // trim เฉพาะเมื่อจำเป็น
      if(oldestDate<cutoff400){
        finalOrders=finalOrders.filter(o=>(o.date||o.ts?.split("T")[0]||"")>=cutoff300);
        finalLedger=finalLedger.filter(e=>e.type==="initial"||(e.ts?.split("T")[0]||"")>=cutoff300);
      }
    }

    const finalData={...d,orders:finalOrders};
    // batch: setState ทั้งหมดใน 1 batch ลด re-render จาก 4 ครั้ง → 1 ครั้ง
    setData(finalData);
    setLedger(finalLedger);
    setCosts(cs);
    setCtof(ct);
    // localStorage write แบบ async ไม่บล็อก UI
    setTimeout(()=>{
      ls_set(SK_DATA,finalData);
      ls_set(SK_LDGR,finalLedger);
      ls_set(SK_COST,cs);
      ls_set(SK_CTOF,ct);
    },0);
    if(sync){
      isDirty.current=true;
      localStorage.setItem("rt10_dirty","1"); // บันทึกค้างไว้ข้ามการเปิดแอป
      syncUp(finalData,finalLedger,cs,ct,rcpt);
    }
  },[data,ledger,costs,ctof,rcpt,syncUp]);

  const persistRcpt=r=>{ isDirty.current=true; localStorage.setItem("rt10_dirty","1"); setRcptSt(r); ls_set(SK_RCPT,r); };

  const handleRestore=async()=>{
    setIsRestoring(true);
    setSyncSt(s=>({...s,status:"syncing"}));
    try {
      const snap=await sbFetch();
      if(snap){
        // sbFetch ใหม่คืน { ...data, _sbUpdatedAt } รวมกัน
        const sbTs=snap._sbUpdatedAt||"";
        const d=snap.data||snap; // compat: รองรับทั้ง format เก่าและใหม่
        if(!d.addons)d.addons=[];
        if(!d.freeOpts)d.freeOpts=[];
        if(!d.discounts)d.discounts=[];
        if(!d.categories||!d.categories.length)d.categories=DEF_DATA.categories;
        setData(d); ls_set(SK_DATA,d);
        setLedger(snap.ledger||d.ledger||[]); ls_set(SK_LDGR,snap.ledger||d.ledger||[]);
        setCosts(snap.costs||d.costs||{}); ls_set(SK_COST,snap.costs||d.costs||{});
        setCtof(snap.ctof||d.ctof||{}); ls_set(SK_CTOF,snap.ctof||d.ctof||{});
        const r=snap.rcpt||d.rcpt;
        if(r){ setRcptSt(r); ls_set(SK_RCPT,r); }
        // บันทึก timestamp ของ Supabase ลง local เพื่อใช้เปรียบเทียบ conflict
        if(sbTs){ ls_set(SK_SYNC,{lastSynced:sbTs}); setSyncSt({status:"synced",lastSynced:sbTs}); }
        isDirty.current=false;
        localStorage.removeItem("rt10_dirty"); // ข้อมูลตรงกับ Supabase แล้ว
      } else setModal({type:"alert",msg:"ไม่พบข้อมูลบน Supabase"});
    } catch(e){ setModal({type:"alert",msg:"เชื่อมต่อ Supabase ไม่ได้\n"+e.message}); }
    setSyncSt(s=>({...s,status:navigator.onLine?"synced":"offline"}));
    setIsRestoring(false);
  };

  const sortedCats  = data.categories.slice().sort((a,b)=>a.order-b.order);
  const catProducts = data.products.filter(p=>p.categoryId===activeCat).sort((a,b)=>a.order-b.order);

  // ── Cart key & note builders ──
  function buildKey(prodId,variId,addons,freeSelections,discounts){
    const ak=addons.map(a=>a.id).sort().join(",");
    const fk=freeSelections.map(f=>f.groupId+":"+f.optId).sort().join(",");
    const dk=discounts.map(d=>d.id).sort().join(",");
    return `${prodId}|${variId}|${ak}|${fk}|${dk}`;
  }
  function buildNote(addons,freeSelections,discounts){
    const parts=[];
    if(addons.length)       parts.push(addons.map(a=>`${a.name}+${a.price}`).join(", "));
    if(freeSelections.length) parts.push(freeSelections.map(f=>f.optLabel).join(", "));
    if(discounts.length)    parts.push(discounts.map(d=>`${d.name}-${d.amount}`).join(", "));
    return parts.join(" | ");
  }
  function calcPrice(vari,addons,discounts){
    const plus=addons.reduce((s,a)=>s+a.price,0);
    const minus=discounts.reduce((s,d)=>s+d.amount,0);
    return Math.max(0, vari.price+plus-minus);
  }

  function addToCart(prod,vari,selAddons=[],selFree=[],selDis=[]){
    const key=buildKey(prod.id,vari.id,selAddons,selFree,selDis);
    const price=calcPrice(vari,selAddons,selDis);
    const note=buildNote(selAddons,selFree,selDis);
    setCart(c=>{
      const ex=c.find(i=>i.key===key);
      if(ex) return c.map(i=>i.key===key?{...i,qty:i.qty+1}:i);
      return [...c,{key,productId:prod.id,variantId:vari.id,name:prod.name,variant:vari.name,price,unit:prod.unit||"",note,selAddons,selFree,selDis,qty:1,done:false}];
    });
  }
  function updateCartItem(oldKey,prod,vari,selAddons,selFree,selDis,oldQty){
    const newKey=buildKey(prod.id,vari.id,selAddons,selFree,selDis);
    const price=calcPrice(vari,selAddons,selDis);
    const note=buildNote(selAddons,selFree,selDis);
    const newItem={key:newKey,productId:prod.id,variantId:vari.id,name:prod.name,variant:vari.name,price,unit:prod.unit||"",note,selAddons,selFree,selDis,qty:oldQty,done:false};
    setCart(c=>{
      const others=c.filter(i=>i.key!==oldKey);
      const ex=others.find(i=>i.key===newKey);
      if(ex) return others.map(i=>i.key===newKey?{...i,qty:i.qty+oldQty}:i);
      return c.map(i=>i.key===oldKey?newItem:i);
    });
  }
  function openEditModal(item){
    const prod=data.products.find(p=>p.id===item.productId); if(!prod)return;
    const initV=prod.variants.find(v=>v.id===item.variantId)||null;
    setModal({type:"editCartItem",product:prod,oldKey:item.key,oldQty:item.qty,initV,initAo:item.selAddons||[],initFree:item.selFree||[],initDis:item.selDis||[]});
  }

  function cartQty(key,d){ setCart(c=>c.map(i=>i.key===key?{...i,qty:Math.max(0,i.qty+d)}:i).filter(i=>i.qty>0)); }
  function cartDone(key){ setCart(c=>c.map(i=>i.key===key?{...i,done:!i.done}:i)); }
  const cartTotal=cart.reduce((s,i)=>s+i.price*i.qty,0);

  // ── Date ──
  function requestDateChange(nd){ if(!nd)return; if(nd===todayStr()){setDD(nd);setNN(peekOrderNum(nd));return;} setPend(nd);setModal({type:"confirmDate",newDate:nd}); }
  function confirmDateChange(){ if(pendDate){setDD(pendDate);setNN(peekOrderNum(pendDate));setPend(null);} setModal(null); }

  // ── Checkout ──
  function checkout(){ if(!cart.length)return; if(dispDate!==todayStr()) setModal({type:"confirmOrderDate",date:dispDate,cartTotal}); else setModal({type:"payment",received:"",total:cartTotal}); }
  function confirmPay(lastCart,lastTotal,paymentMethod="cash"){
    const rcv=paymentMethod==="qr"?lastTotal:parseInt(modal.received||"0",10);
    if(paymentMethod==="cash"&&rcv<lastTotal)return;
    const orderNum=getNextOrderNum(dispDate); setNN(peekOrderNum(dispDate));
    const order={id:uid(),orderNum,date:dispDate,items:[...lastCart],total:lastTotal,received:rcv,change:rcv-lastTotal,paymentMethod,ts:new Date().toISOString(),isCanceled:false};
    persist({...data,orders:[...data.orders,order].slice(-MAX_ORDERS)},null,null,null,true);
    setModal({type:"change",change:rcv-lastTotal,received:rcv,total:lastTotal,order,rcpt});
  }
  function dismissChange(){ setCart([]); setNN(peekOrderNum(dispDate)); setModal(null); }
  function voidOrder(id){ persist({...data,orders:data.orders.map(o=>o.id===id?{...o,isCanceled:true}:o)},null,null,null,true); }
  function hardDelete(id){ persist({...data,orders:data.orders.filter(o=>o.id!==id)},null,null,null,true); }

  // ── Ledger ──
  function addLedgerEntry(entry,ctofPatch){
    const nl=[...ledger,{...entry,id:uid(),ts:new Date().toISOString()}].slice(-MAX_ORDERS);
    persist(null,nl,null,ctofPatch?{...ctof,...ctofPatch}:ctof,true);
  }
  function undoLedger(id){
    const e=ledger.find(x=>x.id===id); if(!e)return;
    const nl=ledger.filter(x=>x.id!==id);
    const nc={...ctof};
    if(e.type==="category")(e.catIds||(e.catId?[e.catId]:[])).forEach(cid=>delete nc[cid]);
    persist(null,nl,null,nc,true);
  }
  function addCashTx(entry){ persist(null,[...ledger,{...entry,id:uid(),ts:new Date().toISOString()}].slice(-MAX_ORDERS),null,null,true); }
  function clearData(){ persist({...data,orders:[]},ledger.filter(e=>e.type==="initial"),costs,{},true); }

  // ── Linked options for a product ──
  function getLinked(prod){
    return {
      addons:   (data.addons||[]).filter(a=>(prod.linkedAddons||[]).includes(a.id)),
      freeOpts: (data.freeOpts||[]).filter(f=>(prod.linkedFreeOpts||[]).includes(f.id)),
      discounts:(data.discounts||[]).filter(d=>(prod.linkedDiscounts||[]).includes(d.id)),
    };
  }

  const badge=dateBadge(dispDate);

  return (
    <div style={{fontFamily:"'Sarabun','Noto Sans Thai',sans-serif",background:"#F5F0EA",height:"100vh",overflow:"hidden",display:"flex",flexDirection:"column",userSelect:"none"}}>

      {/* Loading Screen — ล็อค UI ขณะดึงข้อมูลจาก Supabase */}
      {isRestoring&&<div style={{position:"fixed",inset:0,background:"#2C1810",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:999}}>
        <Coffee size={48} color="#D4A574" style={{marginBottom:20,opacity:.9}}/>
        <div style={{fontSize:20,fontWeight:700,color:"#D4A574",marginBottom:8}}>RoomTwo Coffee</div>
        <div style={{fontSize:14,color:"#C8A882",marginBottom:32}}>กำลังโหลดข้อมูล...</div>
        <div style={{width:180,height:4,background:"rgba(255,255,255,.15)",borderRadius:4,overflow:"hidden"}}>
          <div style={{height:"100%",background:"#D4A574",borderRadius:4,animation:"loading 1.4s ease-in-out infinite",width:"60%"}}/>
        </div>
        <style>{`@keyframes loading{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
      </div>}

      {/* TOP BAR */}
      <div style={{background:"#2C1810",padding:"14px 20px",display:"flex",alignItems:"center",gap:12,flexShrink:0,zIndex:100,minHeight:64,position:"sticky",top:0,width:"100%",boxSizing:"border-box"}}>
        <Coffee size={26} color="#D4A574"/>
        <span style={{fontWeight:700,fontSize:19,letterSpacing:"0.07em",color:"#D4A574"}}>RoomTwo Coffee</span>
        <SyncIndicator syncSt={syncSt} onRestore={handleRestore} orders={data.orders} ledger={ledger}/>
        <div style={{flex:1}}/>
        <DatePill dispDate={dispDate} badge={badge} onChangeRequest={requestDateChange}/>
        {badge&&<button onClick={()=>{setDD(todayStr());setNN(peekOrderNum(todayStr()));}} style={{background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.2)",color:"#C8A882",borderRadius:20,padding:"7px 14px",fontSize:13,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}><RotateCcw size={13}/> รีเซ็ต</button>}
        {[["pos","🧾","POS"],["manage","⚙️","จัดการ"],["report","📊","รายงาน"],["ledger","📒","บัญชี"],["rcptset","🖨️","ตั้งค่าบิล"]].map(([k,ic,lb])=>(
          <button key={k} onClick={()=>setView(k)} style={{background:view===k?"#D4A574":"rgba(255,255,255,.09)",color:view===k?"#2C1810":"#C8A882",border:"none",borderRadius:11,padding:"9px 16px",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"inherit",transition:"all .18s",minHeight:42}}>{ic} {lb}</button>
        ))}
        <span style={{fontSize:10,color:"rgba(255,255,255,.25)",alignSelf:"flex-end",paddingBottom:2,letterSpacing:"0.05em"}}>v1.1.3</span>
      </div>

      {/* VIEWS */}
      {view==="pos"     && <PosView sortedCats={sortedCats} catProducts={catProducts} activeCat={activeCat} setActive={setActive} cart={cart} cartTotal={cartTotal} cartQty={cartQty} cartDone={cartDone} checkout={checkout} setCart={setCart} setModal={setModal} nextNum={nextNum} data={data} openEditModal={openEditModal} getLinked={getLinked} addToCart={addToCart}/>}
      {view==="manage"  && <ManageView data={data} persist={(nd,s)=>persist(nd,null,null,null,s)}/>}
      {view==="report"  && <ReportView data={data} dispDate={dispDate} onVoid={voidOrder} onHardDelete={hardDelete} rcpt={rcpt} costs={costs} setCosts={cs=>persist(null,null,cs,null,true)} onLedgerCommit={addLedgerEntry} ctof={ctof} ledger={ledger}/>}
      {view==="ledger"  && <LedgerView ledger={ledger} cash={cash} data={data} dispDate={dispDate} onUndoEntry={undoLedger} onAddCashTx={addCashTx}/>}
      {view==="rcptset" && <ReceiptSettingsView settings={rcpt} onSave={persistRcpt} onClearData={clearData}/>}

      {/* MODALS */}
      {modal?.type==="order"&&<Overlay onClose={()=>setModal(null)} wide><OrderModal product={modal.product} linked={getLinked(modal.product)} onConfirm={(v,ao,fr,dis)=>{addToCart(modal.product,v,ao,fr,dis);setModal(null);}}/></Overlay>}
      {modal?.type==="editCartItem"&&<Overlay onClose={()=>setModal(null)} wide><OrderModal product={modal.product} linked={getLinked(modal.product)} isEditing initV={modal.initV} initAo={modal.initAo} initFree={modal.initFree} initDis={modal.initDis} onConfirm={(v,ao,fr,dis)=>{updateCartItem(modal.oldKey,modal.product,v,ao,fr,dis,modal.oldQty);setModal(null);}}/></Overlay>}
      {modal?.type==="payment"&&<Overlay onClose={()=>setModal(null)} wide><PaymentModal modal={modal} setModal={setModal} cartTotal={cartTotal} rcpt={rcpt} onConfirm={()=>confirmPay(cart,cartTotal,"cash")} onConfirmQR={()=>confirmPay(cart,cartTotal,"qr")}/></Overlay>}
      {modal?.type==="change"&&<Overlay onClose={dismissChange} wide><ChangeModal modal={modal} onDismiss={dismissChange}/></Overlay>}
      {modal?.type==="viewReceipt"&&<Overlay onClose={()=>setModal(null)} wide><ChangeModal modal={modal} onDismiss={()=>setModal(null)}/></Overlay>}
      {modal?.type==="alert"&&<Overlay onClose={()=>setModal(null)}><AlertModal msg={modal.msg} onClose={()=>setModal(null)}/></Overlay>}
      {modal?.type==="conflict"&&<Overlay onClose={()=>setModal(null)}>
        <div style={{textAlign:"center",padding:"8px 0"}}>
          <AlertTriangle size={38} color="#C87941" style={{margin:"0 auto 12px"}}/>
          <div style={{fontWeight:700,fontSize:16,color:"#2C1810",marginBottom:8}}>ข้อมูลไม่ตรงกัน</div>
          <div style={{fontSize:13,color:"#5C4A36",marginBottom:6,lineHeight:1.7}}>คุณแก้ไขข้อมูลขณะ Offline<br/>แต่บน Supabase มีข้อมูลที่ใหม่กว่า</div>
          <div style={{background:"#F5F0EA",borderRadius:10,padding:"10px 14px",marginBottom:18,fontSize:12,color:"#8C7C6C"}}>
            <div>Supabase อัปเดตล่าสุด: {modal.sbTs?fmtDT(modal.sbTs):"ไม่ทราบ"}</div>
            <div>เครื่องนี้อัปเดตล่าสุด: {modal.localTs?fmtDT(modal.localTs):"ไม่ทราบ"}</div>
          </div>
          <div style={{fontSize:12,color:"#C84B4B",marginBottom:16}}>⚠️ เลือกอย่างระมัดระวัง ข้อมูลที่ไม่เลือกจะหายไป</div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={()=>{setModal(null);handleRestore();}}
              style={{flex:1,background:"#4A7C6B",color:"#FFF",border:"none",borderRadius:10,padding:"11px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
              ใช้ข้อมูล Supabase
            </button>
            <button onClick={()=>{
              // force upload ข้อมูลในเครื่องโดย bypass dirty flag
              setSyncSt(s=>({...s,status:"syncing"}));
              sbUpsert({data,ledger:ledger.slice(-MAX_ORDERS),costs,ctof,rcpt})
                .then(ts=>{ const t=ts||new Date().toISOString(); setSyncSt({status:"synced",lastSynced:t}); ls_set(SK_SYNC,{lastSynced:t}); })
                .catch(()=>setSyncSt(s=>({...s,status:"error"})));
              setModal(null);
            }} style={{flex:1,background:"#C87941",color:"#FFF",border:"none",borderRadius:10,padding:"11px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
              ใช้ข้อมูลในเครื่อง
            </button>
          </div>
        </div>
      </Overlay>}
      {modal?.type==="confirm"&&<Overlay onClose={()=>setModal(null)}><ConfirmModal {...modal} onConfirm={()=>{modal.onConfirm();setModal(null);}} onCancel={()=>setModal(null)}/></Overlay>}
      {modal?.type==="confirmDate"&&<Overlay onClose={()=>setModal(null)}><ConfirmModal icon={<CalendarDays size={36} color="#C87941" style={{margin:"0 auto 12px"}}/>} msg={`เปลี่ยนวันที่เป็น\n"${fmtDate(modal.newDate)}"\nยืนยัน?`} confirmLabel="ยืนยัน" confirmColor="#6B4F3A" onConfirm={confirmDateChange} onCancel={()=>setModal(null)}/></Overlay>}
      {modal?.type==="confirmOrderDate"&&<Overlay onClose={()=>setModal(null)}><ConfirmModal icon={<AlertTriangle size={36} color="#C87941" style={{margin:"0 auto 12px"}}/>} msg={`ออเดอร์จะถูกบันทึกในวันที่\n"${fmtDate(modal.date)}"\nยืนยัน?`} confirmLabel="ยืนยัน" confirmColor="#6B4F3A" onConfirm={()=>setModal({type:"payment",received:"",total:modal.cartTotal})} onCancel={()=>setModal(null)}/></Overlay>}
    </div>
  );
}

// ── SyncIndicator ──
function SyncIndicator({syncSt,onRestore,orders,ledger}){
  const [open,setOpen]=useState(false);
  const isDev=window.location.hostname==="localhost"||window.location.hostname==="127.0.0.1";
  const c=isDev
    ? {color:"#7941C8",label:"DEV MODE"}
    : ({synced:{color:"#6CC97A",label:"Synced"},syncing:{color:"#C8A841",label:"Syncing..."},offline:{color:"#C96C6C",label:"Offline"},error:{color:"#C96C6C",label:"Error"}}[syncSt.status]||{color:"#C8A882",label:""});

  // คำนวณ % ความจุ 400 วัน จาก orders
  const storageInfo = useMemo(()=>{
    if(!orders||orders.length===0) return {pct:0,days:0,oldestDate:null};
    const sorted=[...orders].sort((a,b)=>new Date(a.ts)-new Date(b.ts));
    const oldest=sorted[0];
    const oldestDate=oldest.date||oldest.ts?.split("T")[0]||todayStr();
    const msPerDay=1000*60*60*24;
    const days=Math.floor((new Date()-new Date(oldestDate+"T00:00:00"))/msPerDay);
    const pct=Math.min(100, Math.round(days/400*100));
    return {pct,days,oldestDate};
  },[orders]);

  // สี circular progress ตาม %
  const pctColor = storageInfo.pct>=90?"#C84B4B":storageInfo.pct>=70?"#C87941":"#6CC97A";

  // SVG circular progress
  const r=22, circ=2*Math.PI*r;
  const dash=circ*(1-storageInfo.pct/100);

  return (
    <div style={{position:"relative"}}>
      <div onClick={()=>setOpen(!open)} style={{display:"flex",alignItems:"center",gap:5,background:"rgba(255,255,255,.07)",borderRadius:20,padding:"3px 10px",border:`1px solid ${isDev?"rgba(121,65,200,.5)":"rgba(255,255,255,.12)"}`,cursor:"pointer"}}>
        <div style={{width:7,height:7,borderRadius:"50%",background:c.color,boxShadow:`0 0 5px ${c.color}`,flexShrink:0}}/>
        <span style={{fontSize:11,color:c.color,whiteSpace:"nowrap"}}>{c.label}</span>
      </div>
      {open&&<div style={{position:"absolute",top:"calc(100% + 8px)",left:0,background:"#2C1810",border:"1px solid rgba(255,255,255,.15)",borderRadius:12,padding:"16px",minWidth:260,zIndex:999,boxShadow:"0 8px 24px rgba(0,0,0,.5)"}}>
        {isDev&&<div style={{fontSize:12,color:"#C8A841",marginBottom:10,padding:"6px 10px",background:"rgba(121,65,200,.2)",borderRadius:8,lineHeight:1.5}}>🚫 DEV MODE — Sync ถูกบล็อก</div>}

        {/* Circular Storage Indicator */}
        <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:12,padding:"10px 12px",background:"rgba(255,255,255,.06)",borderRadius:10}}>
          {/* SVG Circle */}
          <div style={{position:"relative",flexShrink:0}}>
            <svg width={54} height={54} style={{transform:"rotate(-90deg)"}}>
              {/* track */}
              <circle cx={27} cy={27} r={r} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth={5}/>
              {/* progress */}
              <circle cx={27} cy={27} r={r} fill="none" stroke={pctColor} strokeWidth={5}
                strokeDasharray={circ} strokeDashoffset={dash}
                strokeLinecap="round"
                style={{transition:"stroke-dashoffset .6s ease, stroke .3s ease"}}/>
            </svg>
            {/* % ตรงกลาง */}
            <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:pctColor}}>
              {storageInfo.pct}%
            </div>
          </div>
          {/* ข้อความข้างๆ */}
          <div>
            <div style={{fontSize:12,fontWeight:700,color:"#F5E8D8",marginBottom:3}}>ความจุข้อมูล</div>
            <div style={{fontSize:11,color:"#C8A882",lineHeight:1.6}}>
              {storageInfo.days} / 400 วัน<br/>
              {storageInfo.oldestDate?<span>ข้อมูลเก่าสุด: {fmtDateS(storageInfo.oldestDate)}</span>:<span>ยังไม่มีออเดอร์</span>}
            </div>
            {storageInfo.pct>=90&&<div style={{fontSize:10,color:"#C84B4B",marginTop:4,fontWeight:600}}>⚠️ ใกล้ถึงรอบล้างข้อมูลเก่า</div>}
          </div>
        </div>

        <div style={{fontSize:11,color:"#C8A882",marginBottom:10,lineHeight:1.6}}>{syncSt.lastSynced?`ซิงก์ล่าสุด: ${fmtDT(syncSt.lastSynced)}`:"ยังไม่เคยซิงก์"}</div>
        <button onClick={()=>{setOpen(false);onRestore();}} style={{width:"100%",background:"rgba(255,255,255,.1)",color:"#F5E8D8",border:"1px solid rgba(255,255,255,.2)",borderRadius:8,padding:"7px 10px",fontSize:12,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><Download size={12}/> ดึงข้อมูลจาก Supabase</button>
      </div>}
    </div>
  );
}

// ── DatePill ──
function DatePill({dispDate,badge,onChangeRequest}){
  const [ed,setEd]=useState(false);
  if(ed) return <input type="date" defaultValue={dispDate} autoFocus style={{background:"rgba(255,255,255,.14)",border:"1px solid rgba(255,255,255,.35)",color:"#F5E8D8",borderRadius:20,padding:"4px 12px",fontSize:12,fontFamily:"inherit",outline:"none",colorScheme:"dark"}} onChange={e=>{if(e.target.value){onChangeRequest(e.target.value);setEd(false);}}} onBlur={()=>setEd(false)}/>;
  return (
    <button onClick={()=>setEd(true)} style={{background:"rgba(255,255,255,.08)",border:"1px solid rgba(255,255,255,.18)",color:"#C8A882",borderRadius:20,padding:"5px 12px",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",gap:5,fontFamily:"inherit"}}>
      <CalendarDays size={12}/>{fmtDate(dispDate)}
      {badge&&<span style={{background:badge.bg,borderRadius:10,padding:"0 6px",fontSize:10,color:"#FFF",marginLeft:2}}>{badge.label}</span>}
    </button>
  );
}

// ══════════════════════════════════════════════════
// POS VIEW
// ══════════════════════════════════════════════════
function PosView({sortedCats,catProducts,activeCat,setActive,cart,cartTotal,cartQty,cartDone,checkout,setCart,setModal,nextNum,data,openEditModal,getLinked,addToCart}){
  const unitLabel=cart.length===0?"":(()=>{const u={};cart.forEach(i=>{const k=i.unit||"รายการ";u[k]=(u[k]||0)+i.qty;});return Object.keys(u).map(k=>`${u[k]} ${k}`).join(", ");})();
  return (
    <div style={{display:"flex",flex:1,overflow:"hidden",height:"calc(100vh - 64px)"}}>
      {/* Categories — scroll independently */}
      <div style={{width:150,height:"100%",background:"#EDE6DC",borderRight:"1px solid #D4C4B0",overflowY:"auto",padding:"12px 8px",display:"flex",flexDirection:"column",gap:8,flexShrink:0,boxSizing:"border-box"}}>
        {sortedCats.map(cat=>(
          <button key={cat.id} onClick={()=>setActive(cat.id)}
            style={{background:activeCat===cat.id?cat.color:"transparent",color:activeCat===cat.id?(cat.textColor||"#FFF"):"#5C4A36",border:`2px solid ${activeCat===cat.id?cat.color:"#C4B4A0"}`,borderRadius:12,padding:"14px 8px",fontSize:16,fontWeight:700,cursor:"pointer",textAlign:"center",transition:"all .18s",fontFamily:"inherit",width:"100%",lineHeight:1.3,flexShrink:0}}>
            {cat.name}
          </button>
        ))}
        <div style={{flex:1,minHeight:8}}/>
      </div>
      {/* Products — scroll independently */}
      <div style={{flex:1,height:"100%",overflowY:"auto",padding:16,background:"#F5F0EA",boxSizing:"border-box"}}>
        {catProducts.length===0?<div style={{textAlign:"center",color:"#9C8C7C",marginTop:80,fontSize:18}}><Coffee size={48} style={{margin:"0 auto 16px",opacity:.35}}/><br/>ยังไม่มีสินค้า</div>
          :<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:16}}>
            {catProducts.map(p=>{
              const {addons,freeOpts,discounts}=getLinked(p);
              const hasOpts=addons.length+freeOpts.length+discounts.length>0;
              return (
                <div key={p.id} onClick={()=>setModal({type:"order",product:p})}
                  style={{background:p.color,borderRadius:18,minHeight:140,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:16,gap:8,cursor:"pointer",boxShadow:"0 3px 12px rgba(0,0,0,.1)",transition:"all .18s",userSelect:"none"}}>
                  {p.image?<img src={p.image} alt={p.name} style={{width:68,height:68,borderRadius:12,objectFit:"cover"}}/>
                    :<span style={{fontSize:17,fontWeight:700,color:p.textColor||"#FFF",textAlign:"center",lineHeight:1.4}}>{p.name}</span>}
                  <span style={{fontSize:15,color:p.textColor?`${p.textColor}CC`:"rgba(255,255,255,.85)",fontWeight:600}}>{p.variants.length===1?`฿${p.variants[0].price}`:`฿${Math.min(...p.variants.map(v=>v.price))}+`}</span>
                  {hasOpts&&<span style={{fontSize:11,color:p.textColor?`${p.textColor}99`:"rgba(255,255,255,.65)"}}>+ ตัวเลือก</span>}
                </div>
              );
            })}
          </div>}
      </div>
      {/* Cart — header fixed, items scroll, footer fixed */}
      <div style={{width:340,height:"100%",background:"#FFF8F2",borderLeft:"1px solid #E4D4C0",display:"flex",flexDirection:"column",flexShrink:0}}>
        {/* Header — stays at top always */}
        <div style={{padding:"14px 16px",borderBottom:"1px solid #E4D4C0",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0,background:"#FFF8F2"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <ShoppingCart size={20} color="#6B4F3A"/>
            <span style={{fontWeight:700,fontSize:18,color:"#2C1810"}}>ออเดอร์</span>
            <span style={{background:"#EDE6DC",color:"#6B4F3A",borderRadius:12,padding:"2px 12px",fontSize:15,fontWeight:700}}>{fmtNum(nextNum)}</span>
          </div>
          {cart.length>0&&<button onClick={()=>setCart([])} style={{background:"none",border:"none",color:"#C88C6C",cursor:"pointer",fontSize:14,fontFamily:"inherit"}}>ล้างทั้งหมด</button>}
        </div>
        {/* Items — scrollable */}
        <div style={{flex:1,overflowY:"auto",padding:"8px 12px"}}>
          {cart.length===0?<div style={{textAlign:"center",color:"#B8A898",marginTop:60,fontSize:16}}><ShoppingCart size={40} style={{margin:"0 auto 12px",opacity:.4}}/><br/>ยังไม่มีรายการ</div>
            :cart.map(item=><CartItem key={item.key} item={item} onQty={cartQty} onDone={cartDone} onEdit={openEditModal}/>)}
        </div>
        {/* Footer — stays at bottom always */}
        <div style={{padding:"14px 16px",paddingBottom:"max(14px, env(safe-area-inset-bottom, 14px))",borderTop:"1px solid #E4D4C0",flexShrink:0,background:"#FFF8F2"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:12,alignItems:"center"}}>
            <span style={{color:"#5C4A36",fontSize:14}}>{unitLabel||"ยังไม่มีรายการ"}</span>
            <span style={{fontWeight:700,fontSize:26,color:"#2C1810"}}>{baht(cartTotal)}</span>
          </div>
          <button onClick={checkout} style={{width:"100%",background:cart.length?"#2C1810":"#B0A098",color:"#F5E8D8",border:"none",borderRadius:14,padding:"16px",fontSize:20,fontWeight:700,cursor:cart.length?"pointer":"not-allowed",fontFamily:"inherit",transition:"all .18s"}}>💳 จ่ายเงิน</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════
// ORDER MODAL  (3 sections: Add-on | ตัวเลือกเสริม | ส่วนลด)
// ══════════════════════════════════════════════════
function OrderModal({product,linked,onConfirm,isEditing=false,initV=null,initAo=[],initFree=[],initDis=[]}){
  const {addons,freeOpts,discounts}=linked;
  const [selV,   setSelV]  =useState(()=>initV||(product.variants.length===1?product.variants[0]:null));
  const [selAo,  setSelAo] =useState(()=>[...initAo]);
  // selFree = [{groupId, optId, optLabel}]  — one per group max
  const [selFree,setSelFree]=useState(()=>[...initFree]);
  const [selDis, setSelDis]=useState(()=>[...initDis]);

  const toggleAo=ao=>setSelAo(p=>p.find(a=>a.id===ao.id)?p.filter(a=>a.id!==ao.id):[...p,ao]);
  const toggleDis=d=>setSelDis(p=>p.find(x=>x.id===d.id)?p.filter(x=>x.id!==d.id):[...p,d]);
  const toggleFree=(grp,opt)=>setSelFree(p=>{
    const without=p.filter(x=>x.groupId!==grp.id);
    const cur=p.find(x=>x.groupId===grp.id);
    if(cur?.optId===opt.id) return without;
    return [...without,{groupId:grp.id,groupName:grp.groupName,optId:opt.id,optLabel:opt.label}];
  });

  const aoAmt  = selAo.reduce((s,a)=>s+a.price,0);
  const disAmt = selDis.reduce((s,d)=>s+d.amount,0);
  const total  = Math.max(0,(selV?.price||0)+aoAmt-disAmt);
  const canConfirm=!!selV;

  return (
    <div>
      {isEditing&&<div style={{background:"#EDE6DC",borderRadius:9,padding:"6px 12px",marginBottom:12,fontSize:12,color:"#6B4F3A",display:"flex",alignItems:"center",gap:5}}>✎ โหมดแก้ไขรายการ</div>}
      <div style={{fontWeight:700,fontSize:17,color:"#2C1810",marginBottom:4,textAlign:"center"}}>{product.name}</div>
      {product.unit&&<div style={{fontSize:12,color:"#8C7C6C",textAlign:"center",marginBottom:14}}>หน่วย: {product.unit}</div>}

      {/* Variants */}
      <SectionLabel>รูปแบบ <span style={{color:"#C84B4B"}}>*</span></SectionLabel>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
        {product.variants.map(v=>(
          <button key={v.id} onClick={()=>setSelV(v)}
            style={{background:selV?.id===v.id?product.color:"#F5F0EA",color:selV?.id===v.id?"#FFF":"#2C1810",border:`2px solid ${selV?.id===v.id?product.color:"#D4C4B0"}`,borderRadius:11,padding:"11px 16px",fontSize:14,fontWeight:600,cursor:"pointer",display:"flex",justifyContent:"space-between",fontFamily:"inherit",transition:"all .15s"}}>
            <span>{v.name}</span><span>฿{v.price}</span>
          </button>
        ))}
      </div>

      {/* Add-ons (บวกราคา) */}
      {addons.length>0&&(
        <div style={{marginBottom:16}}>
          <SectionLabel><Tag size={11} style={{display:"inline",marginRight:4,verticalAlign:"middle"}}/>Add-on (บวกราคา)</SectionLabel>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
            {addons.map(ao=>{
              const act=selAo.find(a=>a.id===ao.id);
              return (
                <button key={ao.id} onClick={()=>toggleAo(ao)}
                  style={{background:act?"#2C1810":"#F0E8DC",color:act?"#FFF":"#5C4A36",border:`1.5px solid ${act?"#2C1810":"#D4C4B0"}`,borderRadius:9,padding:"8px 4px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"center",lineHeight:1.5}}>
                  {act?"✓ ":""}{ao.name}<br/><span style={{fontSize:10,color:act?"#6CC97A":"#7A9E6B"}}>+฿{ao.price}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Free options (ไม่คิดเงิน) — per group */}
      {freeOpts.map(grp=>(
        <div key={grp.id} style={{marginBottom:14}}>
          <SectionLabel><Gift size={11} style={{display:"inline",marginRight:4,verticalAlign:"middle"}}/>{grp.groupName}</SectionLabel>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
            {(grp.options||[]).map(opt=>{
              const act=selFree.find(x=>x.groupId===grp.id&&x.optId===opt.id);
              return (
                <button key={opt.id} onClick={()=>toggleFree(grp,opt)}
                  style={{background:act?"#4A7C6B":"#F0E8DC",color:act?"#FFF":"#5C4A36",border:`1.5px solid ${act?"#4A7C6B":"#D4C4B0"}`,borderRadius:9,padding:"8px 4px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"center"}}>
                  {act?"✓ ":""}{opt.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Discounts (ลบราคา) */}
      {discounts.length>0&&(
        <div style={{marginBottom:16}}>
          <SectionLabel><Percent size={11} style={{display:"inline",marginRight:4,verticalAlign:"middle"}}/>ส่วนลด (หักราคา)</SectionLabel>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
            {discounts.map(d=>{
              const act=selDis.find(x=>x.id===d.id);
              return (
                <button key={d.id} onClick={()=>toggleDis(d)}
                  style={{background:act?"#C84B4B":"#FDE8E8",color:act?"#FFF":"#C84B4B",border:`1.5px solid ${act?"#C84B4B":"#FCA5A5"}`,borderRadius:9,padding:"8px 4px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",textAlign:"center",lineHeight:1.5}}>
                  {act?"✓ ":""}{d.name}<br/><span style={{fontSize:10}}>-฿{d.amount}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Summary strip */}
      {selV&&(
        <div style={{background:"#EDE6DC",borderRadius:10,padding:"8px 12px",marginBottom:14,fontSize:13,color:"#5C4A36"}}>
          <span style={{fontWeight:600}}>{product.name} ({selV.name})</span>
          {selAo.length>0&&<span style={{color:"#2C1810"}}> + {selAo.map(a=>a.name).join(", ")}</span>}
          {selFree.length>0&&<span style={{color:"#4A7C6B"}}> · {selFree.map(f=>f.optLabel).join(", ")}</span>}
          {selDis.length>0&&<span style={{color:"#C84B4B"}}> - {selDis.map(d=>d.name).join(", ")}</span>}
          <span style={{float:"right",fontWeight:700,color:"#2C1810"}}>฿{total}</span>
        </div>
      )}

      <button onClick={()=>canConfirm&&onConfirm(selV,selAo,selFree,selDis)} disabled={!canConfirm}
        style={{width:"100%",background:canConfirm?product.color:"#C0B0A0",color:"#FFF",border:"none",borderRadius:12,padding:"14px",fontSize:16,fontWeight:700,cursor:canConfirm?"pointer":"not-allowed",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        <CheckCircle size={18}/> {isEditing?"✅ ยืนยันการแก้ไข":"ยืนยันเพิ่มลงตะกร้า"}{canConfirm?` — ${baht(total)}`:""}
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════
// SHARED MICRO COMPONENTS — ต้องอยู่ก่อน ManageView และ components อื่นที่ใช้
// ══════════════════════════════════════════════════
const AlertModal=memo(function AlertModal({msg,onClose}){ return<div style={{textAlign:"center",padding:"8px 0"}}><AlertTriangle size={38} color="#C87941" style={{margin:"0 auto 12px"}}/><div style={{fontSize:15,color:"#5C4A36",marginBottom:20,lineHeight:1.6,whiteSpace:"pre-line"}}>{msg}</div><button onClick={onClose} style={{background:"#2C1810",color:"#FFF",border:"none",borderRadius:10,padding:"10px 28px",cursor:"pointer",fontSize:14,fontFamily:"inherit"}}>ตกลง</button></div>; });
const ConfirmModal=memo(function ConfirmModal({icon,msg,confirmLabel,confirmColor,onConfirm,onCancel}){ return<div style={{textAlign:"center",padding:"8px 0"}}>{icon}<div style={{fontSize:15,color:"#5C4A36",marginBottom:22,lineHeight:1.7,whiteSpace:"pre-line"}}>{msg}</div><div style={{display:"flex",gap:10}}><button onClick={onCancel} style={{flex:1,background:"#F0E8DC",color:"#5C4A36",border:"none",borderRadius:10,padding:"11px",fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>ยกเลิก</button><button onClick={onConfirm} style={{flex:1,background:confirmColor||"#C84B4B",color:"#FFF",border:"none",borderRadius:10,padding:"11px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{confirmLabel||"ยืนยัน"}</button></div></div>; })
function Overlay({children,onClose,wide}){ return<div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(28,12,4,.58)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,backdropFilter:"blur(5px)"}}><div onClick={e=>e.stopPropagation()} style={{background:"#FFFCF8",borderRadius:20,padding:26,width:wide?660:390,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 28px 72px rgba(0,0,0,.3)",border:"1px solid #E8D8C8"}}>{children}</div></div>; }
const AddBtn=memo(function AddBtn({children,onClick,color="#2C1810"}){ return<button onClick={onClick} style={{background:color,color:"#FFF",border:"none",borderRadius:10,padding:"9px 16px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}><Plus size={13}/>{children}</button>; })
const SectionLabel=memo(function SectionLabel({children}){ return<div style={{fontSize:12,color:"#8C7C6C",fontWeight:600,marginBottom:7}}>{children}</div>; })
function IconBtn({variant,onClick,children}){
  const s=variant==="del"?{background:"#FDE8E8",color:"#C84B4B"}:{background:"#F0E8DC",color:"#6B4F3A"};
  return<button onClick={onClick} style={{...s,border:"none",borderRadius:8,padding:"7px 9px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{children}</button>;
}
const ChipBtn=memo(function ChipBtn({active,onClick,color,children}){ return<button onClick={onClick} style={{background:active?color:"#F0E8DC",color:active?"#FFF":"#5C4A36",border:"none",borderRadius:20,padding:"4px 14px",fontSize:13,cursor:"pointer",fontFamily:"inherit",transition:"all .15s"}}>{children}</button>; })
const ColorPicker=memo(function ColorPicker({value,onChange}){ return<div style={{display:"flex",flexWrap:"wrap",gap:7,marginTop:2}}>{PALETTE.map(c=><div key={c} onClick={()=>onChange(c)} style={{width:28,height:28,borderRadius:7,background:c,cursor:"pointer",border:value===c?"3px solid #2C1810":"2px solid transparent",boxShadow:value===c?"0 0 0 2px #FFF,0 0 0 4px #2C1810":"none",transition:"all .15s"}}/>)}</div>; });
const ModalTitle=memo(function ModalTitle({children}){ return<div style={{fontWeight:700,fontSize:16,color:"#2C1810",marginBottom:18}}>{children}</div>; })
const Field=memo(function Field({label,children}){ return<div style={{marginBottom:14}}><div style={{fontSize:12,color:"#8C7C6C",marginBottom:5,fontWeight:500}}>{label}</div>{children}</div>; })
const ModalFooter=memo(function ModalFooter({onCancel,onSave}){ return<div style={{display:"flex",gap:10,marginTop:4}}><button onClick={onCancel} style={{flex:1,background:"#F0E8DC",color:"#5C4A36",border:"none",borderRadius:10,padding:"11px",fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>ยกเลิก</button><button onClick={onSave} style={{flex:2,background:"#2C1810",color:"#FFF",border:"none",borderRadius:10,padding:"11px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>บันทึก</button></div>; })
const EmptyMsg=memo(function EmptyMsg({label}){ return<div style={{textAlign:"center",color:"#9C8C7C",padding:"40px 0",fontSize:14}}><Coffee size={32} style={{margin:"0 auto 10px",opacity:.35}}/><br/>{label}</div>; })
const CartItem=memo(function CartItem({item,onQty,onDone,onEdit}){
  return(
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 4px",borderBottom:"1px solid #EDE4DA",opacity:item.done?0.5:1}}>
      <input type="checkbox" checked={item.done} onChange={()=>onDone(item.key)} style={{accentColor:"#6B4F3A",width:20,height:20,cursor:"pointer",flexShrink:0}}/>
      <div onClick={onEdit?()=>onEdit(item):undefined} style={{flex:1,minWidth:0,cursor:onEdit?"pointer":"default"}}>
        <div style={{fontSize:15,fontWeight:700,color:"#2C1810",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",textDecoration:item.done?"line-through":"none"}}>{item.name} ({item.variant}){onEdit&&<span style={{fontSize:11,color:"#C8A882",marginLeft:4}}>✎</span>}</div>
        {item.note&&<div style={{fontSize:12,color:"#7941C8",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>— {item.note}</div>}
        <div style={{fontSize:13,color:"#8C7C6C"}}>฿{item.price} / {item.unit||"รายการ"}</div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
        <button onClick={()=>onQty(item.key,-1)} style={{width:30,height:30,borderRadius:8,border:"1px solid #D4C4B0",background:"#FFF",cursor:"pointer",fontSize:18,color:"#5C4A36",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit",flexShrink:0}}>−</button>
        <span style={{fontSize:16,fontWeight:700,minWidth:22,textAlign:"center",color:"#2C1810"}}>{item.qty}</span>
        <button onClick={()=>onQty(item.key, 1)} style={{width:30,height:30,borderRadius:8,border:"1px solid #D4C4B0",background:"#FFF",cursor:"pointer",fontSize:18,color:"#5C4A36",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit",flexShrink:0}}>+</button>
      </div>
      <span style={{fontSize:14,fontWeight:700,color:"#6B4F3A",minWidth:54,textAlign:"right"}}>{baht(item.price*item.qty)}</span>
    </div>
  );
});

// ── Sortable Row Components (dnd-kit) ──
const SortableCatRow=memo(function SortableCatRow({cat,productCount,onEdit,onDel}){
  const{attributes,listeners,setNodeRef,transform,transition,isDragging}=useSortable({id:cat.id});
  const style={transform:CSS.Transform.toString(transform),transition,opacity:isDragging?0.5:1,zIndex:isDragging?10:undefined};
  return(
    <div ref={setNodeRef} style={{...style,display:"flex",alignItems:"center",gap:10,background:"#FFF8F2",border:`1.5px solid ${isDragging?"#D4A574":"#E8D8C8"}`,borderRadius:13,padding:"11px 14px",boxShadow:isDragging?"0 8px 24px rgba(0,0,0,.12)":undefined}}>
      <div {...attributes} {...listeners} style={{cursor:"grab",touchAction:"none",padding:"4px",color:"#C4B4A0",display:"flex",alignItems:"center"}}>
        <GripVertical size={20}/>
      </div>
      <div style={{width:18,height:18,borderRadius:5,background:cat.color,flexShrink:0}}/>
      <span style={{flex:1,fontWeight:600,fontSize:14,color:"#2C1810"}}>{cat.name}</span>
      <span style={{fontSize:12,color:"#9C8C7C"}}>{productCount} สินค้า</span>
      <IconBtn variant="edit" onClick={e=>{e.stopPropagation();onEdit();}}><Pencil size={13}/></IconBtn>
      <IconBtn variant="del"  onClick={e=>{e.stopPropagation();onDel();}}><Trash2 size={13}/></IconBtn>
    </div>
  );
});

const SortableProdRow=memo(function SortableProdRow({prod,cat,lc,onEdit,onDel}){
  const{attributes,listeners,setNodeRef,transform,transition,isDragging}=useSortable({id:prod.id});
  const style={transform:CSS.Transform.toString(transform),transition,opacity:isDragging?0.5:1,zIndex:isDragging?10:undefined};
  return(
    <div ref={setNodeRef} style={{...style,display:"flex",alignItems:"center",gap:10,background:"#FFF8F2",border:`1.5px solid ${isDragging?"#D4A574":"#E8D8C8"}`,borderRadius:13,padding:"10px 14px",boxShadow:isDragging?"0 8px 24px rgba(0,0,0,.12)":undefined}}>
      <div {...attributes} {...listeners} style={{cursor:"grab",touchAction:"none",padding:"4px",color:"#C4B4A0",display:"flex",alignItems:"center"}}>
        <GripVertical size={20}/>
      </div>
      <div style={{width:38,height:38,borderRadius:9,background:prod.color,flexShrink:0,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"}}>
        {prod.image?<img src={prod.image} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:9,color:"rgba(255,255,255,.9)",fontWeight:700,textAlign:"center",padding:2}}>{prod.name.slice(0,5)}</span>}
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:14,fontWeight:600,color:"#2C1810"}}>{prod.name}{prod.unit&&<span style={{fontSize:11,color:"#8C7C6C",fontWeight:400}}> ({prod.unit})</span>}</div>
        <div style={{fontSize:11,color:"#8C7C6C",display:"flex",gap:6,flexWrap:"wrap",marginTop:2,alignItems:"center"}}>
          {cat&&<span style={{background:cat.color,color:"#FFF",borderRadius:10,padding:"1px 8px",fontSize:10}}>{cat.name}</span>}
          {prod.variants.map(v=><span key={v.id}>{v.name} ฿{v.price}</span>)}
          {lc>0&&<span style={{color:"#7941C8",fontSize:10}}>+{lc} ตัวเลือก</span>}
        </div>
      </div>
      <IconBtn variant="edit" onClick={e=>{e.stopPropagation();onEdit();}}><Pencil size={13}/></IconBtn>
      <IconBtn variant="del"  onClick={e=>{e.stopPropagation();onDel();}}><Trash2 size={13}/></IconBtn>
    </div>
  );
});

const SortableAddonRow=memo(function SortableAddonRow({ao,onEdit,onDel}){
  const{attributes,listeners,setNodeRef,transform,transition,isDragging}=useSortable({id:ao.id});
  const style={transform:CSS.Transform.toString(transform),transition,opacity:isDragging?0.5:1,zIndex:isDragging?10:undefined};
  return(
    <div ref={setNodeRef} style={{...style,display:"flex",alignItems:"center",gap:10,background:"#FFF8F2",border:`1.5px solid ${isDragging?"#D4A574":"#E8D8C8"}`,borderRadius:13,padding:"11px 14px",boxShadow:isDragging?"0 8px 24px rgba(0,0,0,.12)":undefined}}>
      <div {...attributes} {...listeners} style={{cursor:"grab",touchAction:"none",padding:"4px",color:"#C4B4A0",display:"flex",alignItems:"center"}}><GripVertical size={20}/></div>
      <Tag size={16} color="#7941C8" style={{flexShrink:0}}/>
      <div style={{flex:1,fontSize:14,fontWeight:600,color:"#2C1810"}}>{ao.name} <span style={{color:"#7941C8",fontWeight:700}}>+฿{ao.price}</span></div>
      <IconBtn variant="edit" onClick={onEdit}><Pencil size={13}/></IconBtn>
      <IconBtn variant="del"  onClick={onDel}><Trash2 size={13}/></IconBtn>
    </div>
  );
});

// ══════════════════════════════════════════════════
// MANAGE VIEW — tabs: หมวดหมู่ | สินค้า | Add-on | ตัวเลือกเสริม | ส่วนลด
// ══════════════════════════════════════════════════
function ManageView({data,persist}){
  const [tab,setTab]=useState("cats");
  const [filterCat,setFlt]=useState(null);
  const [im,setIM]=useState(null);
  const sortedCats=data.categories.slice().sort((a,b)=>a.order-b.order);
  const addons=(data.addons||[]).slice().sort((a,b)=>(a.order??0)-(b.order??0));
  const freeOpts=data.freeOpts||[], discounts=data.discounts||[];

  useEffect(()=>{ if(tab==="prods"&&!filterCat&&sortedCats.length>0)setFlt(sortedCats[0].id); },[tab]);
  const catProds=filterCat?data.products.filter(p=>p.categoryId===filterCat).sort((a,b)=>a.order-b.order):[];

  const confirm=(msg,fn)=>setIM({type:"confirm",icon:<Trash2 size={36} color="#C84B4B" style={{margin:"0 auto 12px"}}/>,msg,confirmLabel:"ลบเลย",confirmColor:"#C84B4B",onConfirm:fn});
  const catDel =id=>confirm("ลบหมวดหมู่นี้?",()=>{persist({...data,categories:data.categories.filter(c=>c.id!==id),products:data.products.filter(p=>p.categoryId!==id)},true);if(filterCat===id)setFlt(null);});
  const prodDel=id=>confirm("ลบสินค้านี้?",()=>persist({...data,products:data.products.filter(p=>p.id!==id)},true));
  const aoDel  =id=>confirm("ลบ Add-on?",()=>persist({...data,addons:addons.filter(a=>a.id!==id)},true));
  const foDel  =id=>confirm("ลบตัวเลือกเสริม?",()=>persist({...data,freeOpts:freeOpts.filter(f=>f.id!==id)},true));
  const disDel =id=>confirm("ลบส่วนลด?",()=>persist({...data,discounts:discounts.filter(d=>d.id!==id)},true));

  // ── dnd-kit: Category sort ──
  const catSensors=useSensors(
    useSensor(PointerSensor,{activationConstraint:{distance:8}}),
    useSensor(TouchSensor,{activationConstraint:{delay:200,tolerance:8}})
  );
  const handleCatDragEnd=(event)=>{
    const{active,over}=event;
    if(!over||active.id===over.id)return;
    const arr=[...sortedCats];
    const fi=arr.findIndex(x=>x.id===active.id);
    const ti=arr.findIndex(x=>x.id===over.id);
    const[m]=arr.splice(fi,1); arr.splice(ti,0,m);
    persist({...data,categories:reindex(arr)},true);
  };

  // ── dnd-kit: Addon sort ──
  const addonSensors=useSensors(
    useSensor(PointerSensor,{activationConstraint:{distance:8}}),
    useSensor(TouchSensor,{activationConstraint:{delay:200,tolerance:8}})
  );
  const handleAddonDragEnd=(event)=>{
    const{active,over}=event;
    if(!over||active.id===over.id)return;
    const arr=[...addons];
    const fi=arr.findIndex(x=>x.id===active.id);
    const ti=arr.findIndex(x=>x.id===over.id);
    const[m]=arr.splice(fi,1); arr.splice(ti,0,m);
    persist({...data,addons:reindex(arr)},true);
  };
  const prodSensors=useSensors(
    useSensor(PointerSensor,{activationConstraint:{distance:8}}),
    useSensor(TouchSensor,{activationConstraint:{delay:200,tolerance:8}})
  );
  const handleProdDragEnd=(event)=>{
    const{active,over}=event;
    if(!over||active.id===over.id)return;
    const arr=[...catProds];
    const fi=arr.findIndex(x=>x.id===active.id);
    const ti=arr.findIndex(x=>x.id===over.id);
    const[m]=arr.splice(fi,1); arr.splice(ti,0,m);
    persist({...data,products:[...data.products.filter(p=>p.categoryId!==filterCat),...reindex(arr)]},true);
  };

  const TABS=[["cats","📂 หมวดหมู่"],["prods","☕ สินค้า"],["addons","🏷️ Add-on"],["freeopts","ตัวเลือกเสริม"],["discounts","🏷️ ส่วนลด"]];

  return (
    <div style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
      {/* Tab bar */}
      <div style={{display:"flex",gap:8,marginBottom:20,alignItems:"center",flexWrap:"wrap"}}>
        {TABS.map(([k,l])=><button key={k} onClick={()=>setTab(k)} style={{background:tab===k?"#2C1810":"#F0E8DC",color:tab===k?"#FFF":"#5C4A36",border:"none",borderRadius:10,padding:"9px 14px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>)}
        <div style={{flex:1}}/>
        {tab==="cats"     &&<AddBtn onClick={()=>setIM({type:"addCat"})}>เพิ่มหมวดหมู่</AddBtn>}
        {tab==="prods"    &&<AddBtn onClick={()=>setIM({type:"addProd",catId:filterCat||data.categories[0]?.id})}>เพิ่มสินค้า</AddBtn>}
        {tab==="addons"   &&<AddBtn onClick={()=>setIM({type:"addAddon"})}>เพิ่ม Add-on</AddBtn>}
        {tab==="freeopts" &&<AddBtn color="#4A7C6B" onClick={()=>setIM({type:"addFreeOpt"})}>เพิ่มตัวเลือกเสริม</AddBtn>}
        {tab==="discounts"&&<AddBtn color="#C84B4B" onClick={()=>setIM({type:"addDiscount"})}>เพิ่มส่วนลด</AddBtn>}
      </div>
      {(tab==="cats"||tab==="prods")&&<div style={{display:"flex",alignItems:"center",gap:5,fontSize:12,color:"#9C8C7C",marginBottom:14,background:"#EDE6DC",borderRadius:8,padding:"5px 11px",width:"fit-content"}}><GripVertical size={12}/> กดค้างที่ ≡ แล้วลากเพื่อจัดลำดับ</div>}

      {/* CATEGORIES — dnd-kit */}
      {tab==="cats"&&(
        <DndContext sensors={catSensors} collisionDetection={closestCenter} onDragEnd={handleCatDragEnd}>
          <SortableContext items={sortedCats.map(c=>c.id)} strategy={verticalListSortingStrategy}>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {sortedCats.length===0&&<EmptyMsg label="ยังไม่มีหมวดหมู่"/>}
              {sortedCats.map(cat=>(
                <SortableCatRow key={cat.id} cat={cat}
                  productCount={data.products.filter(p=>p.categoryId===cat.id).length}
                  onEdit={()=>setIM({type:"editCat",cat})}
                  onDel={()=>catDel(cat.id)}/>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* PRODUCTS — dnd-kit */}
      {tab==="prods"&&<>
        <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:16}}>
          {sortedCats.map(c=><ChipBtn key={c.id} active={filterCat===c.id} onClick={()=>setFlt(c.id)} color={c.color}>{c.name}</ChipBtn>)}
        </div>
        {!filterCat?<EmptyMsg label="เลือกหมวดหมู่เพื่อดูสินค้า"/>
          :catProds.length===0?<EmptyMsg label="ยังไม่มีสินค้าในหมวดนี้"/>
          :<DndContext sensors={prodSensors} collisionDetection={closestCenter} onDragEnd={handleProdDragEnd}>
            <SortableContext items={catProds.map(p=>p.id)} strategy={verticalListSortingStrategy}>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {catProds.map(p=>{
                  const cat=data.categories.find(c=>c.id===p.categoryId);
                  const lc=(p.linkedAddons?.length||0)+(p.linkedFreeOpts?.length||0)+(p.linkedDiscounts?.length||0);
                  return(
                    <SortableProdRow key={p.id} prod={p} cat={cat} lc={lc}
                      onEdit={()=>setIM({type:"editProd",prod:p})}
                      onDel={()=>prodDel(p.id)}/>
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>}
      </>}

      {/* ADD-ONS — dnd-kit sortable */}
      {tab==="addons"&&<>
        {(tab==="addons")&&<div style={{display:"flex",alignItems:"center",gap:5,fontSize:12,color:"#9C8C7C",marginBottom:14,background:"#EDE6DC",borderRadius:8,padding:"5px 11px",width:"fit-content"}}><GripVertical size={12}/> กดค้างที่ ≡ แล้วลากเพื่อจัดลำดับ</div>}
        {addons.length===0?<EmptyMsg label="ยังไม่มี Add-on"/>:
          <DndContext sensors={addonSensors} collisionDetection={closestCenter} onDragEnd={handleAddonDragEnd}>
            <SortableContext items={addons.map(a=>a.id)} strategy={verticalListSortingStrategy}>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {addons.map(ao=>(
                  <SortableAddonRow key={ao.id} ao={ao}
                    onEdit={()=>setIM({type:"editAddon",addon:ao})}
                    onDel={()=>aoDel(ao.id)}/>
                ))}
              </div>
            </SortableContext>
          </DndContext>}
      </>}

      {/* FREE OPTIONS */}
      {tab==="freeopts"&&<div style={{display:"flex",flexDirection:"column",gap:8}}>
        {freeOpts.length===0&&<EmptyMsg label="ยังไม่มีตัวเลือกเสริม"/>}
        {freeOpts.map(fo=>(
          <div key={fo.id} style={{background:"#FFF8F2",border:"1px solid #E8D8C8",borderRadius:13,padding:"12px 14px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <Gift size={16} color="#4A7C6B" style={{flexShrink:0}}/>
              <div style={{flex:1}}>
                <div style={{fontSize:14,fontWeight:600,color:"#2C1810"}}>{fo.groupName} <span style={{fontSize:11,color:"#4A7C6B",fontWeight:400}}>({fo.options?.length||0} ตัวเลือก)</span></div>
              </div>
              <IconBtn variant="edit" onClick={()=>setIM({type:"editFreeOpt",fo})}><Pencil size={13}/></IconBtn>
              <IconBtn variant="del"  onClick={()=>foDel(fo.id)}><Trash2 size={13}/></IconBtn>
            </div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {(fo.options||[]).map(opt=><span key={opt.id} style={{background:"#EDE6DC",color:"#5C4A36",borderRadius:8,padding:"3px 10px",fontSize:12}}>{opt.label}</span>)}
            </div>
          </div>
        ))}
      </div>}

      {/* DISCOUNTS */}
      {tab==="discounts"&&<div style={{display:"flex",flexDirection:"column",gap:8}}>
        {discounts.length===0&&<EmptyMsg label="ยังไม่มีส่วนลด"/>}
        {discounts.map(d=>(
          <div key={d.id} style={{display:"flex",alignItems:"center",gap:10,background:"#FFF8F2",border:"1px solid #E8D8C8",borderRadius:13,padding:"11px 14px"}}>
            <Percent size={16} color="#C84B4B" style={{flexShrink:0}}/>
            <div style={{flex:1}}><div style={{fontSize:14,fontWeight:600,color:"#2C1810"}}>{d.name} <span style={{color:"#C84B4B",fontWeight:700}}>-฿{d.amount}</span></div></div>
            <IconBtn variant="edit" onClick={()=>setIM({type:"editDiscount",discount:d})}><Pencil size={13}/></IconBtn>
            <IconBtn variant="del"  onClick={()=>disDel(d.id)}><Trash2 size={13}/></IconBtn>
          </div>
        ))}
      </div>}

      {/* Inner Modals */}
      {im?.type==="confirm"    &&<Overlay onClose={()=>setIM(null)}><ConfirmModal {...im} onConfirm={()=>{im.onConfirm();setIM(null);}} onCancel={()=>setIM(null)}/></Overlay>}
      {im?.type==="addCat"     &&<Overlay onClose={()=>setIM(null)}><AddCatModal    data={data} persist={persist} onClose={()=>setIM(null)}/></Overlay>}
      {im?.type==="editCat"    &&<Overlay onClose={()=>setIM(null)}><EditCatModal   cat={im.cat} data={data} persist={persist} onClose={()=>setIM(null)}/></Overlay>}
      {im?.type==="addProd"    &&<Overlay onClose={()=>setIM(null)} wide><AddProdModal  data={data} persist={persist} catId={im.catId} onClose={()=>setIM(null)}/></Overlay>}
      {im?.type==="editProd"   &&<Overlay onClose={()=>setIM(null)} wide><EditProdModal prod={im.prod} data={data} persist={persist} onClose={()=>setIM(null)}/></Overlay>}
      {im?.type==="addAddon"   &&<Overlay onClose={()=>setIM(null)}><AddonFormModal   data={data} persist={persist} onClose={()=>setIM(null)}/></Overlay>}
      {im?.type==="editAddon"  &&<Overlay onClose={()=>setIM(null)}><AddonFormModal   addon={im.addon} data={data} persist={persist} onClose={()=>setIM(null)}/></Overlay>}
      {im?.type==="addFreeOpt" &&<Overlay onClose={()=>setIM(null)} wide><FreeOptModal  data={data} persist={persist} onClose={()=>setIM(null)}/></Overlay>}
      {im?.type==="editFreeOpt"&&<Overlay onClose={()=>setIM(null)} wide><FreeOptModal  fo={im.fo} data={data} persist={persist} onClose={()=>setIM(null)}/></Overlay>}
      {im?.type==="addDiscount" &&<Overlay onClose={()=>setIM(null)}><DiscountModal data={data} persist={persist} onClose={()=>setIM(null)}/></Overlay>}
      {im?.type==="editDiscount"&&<Overlay onClose={()=>setIM(null)}><DiscountModal discount={im.discount} data={data} persist={persist} onClose={()=>setIM(null)}/></Overlay>}
    </div>
  );
}

// ── Form Modals ──
function AddonFormModal({addon,data,persist,onClose}){
  const [name,setName]=useState(addon?.name||"");
  const [price,setPrice]=useState(addon?String(addon.price):"");
  const save=()=>{
    if(!name.trim()||!price)return;
    const list=data.addons||[];
    const item={id:addon?addon.id:`ao${uid()}`,name:name.trim(),price:parseFloat(price)};
    persist({...data,addons:addon?list.map(a=>a.id===addon.id?item:a):[...list,item]},true);
    onClose();
  };
  return(<div><ModalTitle>{addon?"แก้ไข":"เพิ่ม"} Add-on</ModalTitle>
    <Field label="ชื่อ Add-on"><input value={name} onChange={e=>setName(e.target.value)} placeholder="เช่น เพิ่มช็อต" style={iStyle}/></Field>
    <Field label="ราคาที่บวกเพิ่ม (฿)"><input type="number" value={price} onChange={e=>setPrice(e.target.value)} placeholder="10" style={iStyle}/></Field>
    <ModalFooter onCancel={onClose} onSave={save}/></div>);
}

function FreeOptModal({fo,data,persist,onClose}){
  const [groupName,setGN]=useState(fo?.groupName||"");
  const [options,setOpts]=useState(()=>(fo?.options||[]).map(o=>({...o})));
  const addOpt=()=>setOpts(o=>[...o,{id:`o${uid()}`,label:""}]);
  const remOpt=id=>setOpts(o=>o.filter(x=>x.id!==id));
  const updOpt=(id,v)=>setOpts(o=>o.map(x=>x.id===id?{...x,label:v}:x));
  const save=()=>{
    if(!groupName.trim())return;
    const validOpts=options.filter(o=>o.label.trim());
    if(!validOpts.length)return;
    const list=data.freeOpts||[];
    const item={id:fo?fo.id:`fo${uid()}`,groupName:groupName.trim(),options:validOpts};
    persist({...data,freeOpts:fo?list.map(f=>f.id===fo.id?item:f):[...list,item]},true);
    onClose();
  };
  return(<div>
    <ModalTitle>{fo?"แก้ไข":"เพิ่ม"}ตัวเลือกเสริม</ModalTitle>
    <Field label="ชื่อกลุ่ม (เช่น ระดับความหวาน)"><input value={groupName} onChange={e=>setGN(e.target.value)} placeholder="เช่น ความหวาน" style={iStyle}/></Field>
    <Field label="ตัวเลือกในกลุ่ม">
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {options.map(o=>(
          <div key={o.id} style={{display:"flex",gap:6,alignItems:"center"}}>
            <input value={o.label} onChange={e=>updOpt(o.id,e.target.value)} placeholder="เช่น หวานน้อย" style={{...iStyle,flex:1}}/>
            <button onClick={()=>remOpt(o.id)} style={{background:"#FDE8E8",border:"none",borderRadius:7,padding:"6px 8px",cursor:"pointer",color:"#C84B4B"}}><X size={12}/></button>
          </div>
        ))}
        <button onClick={addOpt} style={{background:"none",border:"1px dashed #C4B4A0",borderRadius:8,padding:"7px",fontSize:13,color:"#8C7C6C",cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}><Plus size={12}/> เพิ่มตัวเลือก</button>
      </div>
    </Field>
    <ModalFooter onCancel={onClose} onSave={save}/>
  </div>);
}

function DiscountModal({discount,data,persist,onClose}){
  const [name,setName]=useState(discount?.name||"");
  const [amount,setAmount]=useState(discount?String(discount.amount):"");
  const save=()=>{
    if(!name.trim()||!amount)return;
    const list=data.discounts||[];
    const item={id:discount?discount.id:`dis${uid()}`,name:name.trim(),amount:parseFloat(amount)};
    persist({...data,discounts:discount?list.map(d=>d.id===discount.id?item:d):[...list,item]},true);
    onClose();
  };
  return(<div><ModalTitle>{discount?"แก้ไข":"เพิ่ม"}ส่วนลด</ModalTitle>
    <Field label="ชื่อส่วนลด (เช่น นำแก้วมาเอง)"><input value={name} onChange={e=>setName(e.target.value)} placeholder="เช่น นำแก้วมาเอง" style={iStyle}/></Field>
    <Field label="จำนวนเงินที่หักออก (฿)"><input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="5" style={iStyle}/></Field>
    <ModalFooter onCancel={onClose} onSave={save}/></div>);
}

// ── Product Form (with linked options checkboxes) ──
// CheckRow ต้องอยู่ระดับ top-level — ห้ามอยู่ใน component อื่น
const CheckRow=memo(function CheckRow({label,ids,setIds,items}){
  if(!items||items.length===0) return null;
  return(
    <Field label={label}>
      <div style={{display:"flex",flexWrap:"wrap",gap:7}}>
        {items.map(item=>{
          const active=ids.includes(item.id);
          return(
            <label key={item.id} style={{display:"flex",alignItems:"center",gap:5,fontSize:13,cursor:"pointer",background:active?"#2C1810":"#F0E8DC",color:active?"#FFF":"#5C4A36",borderRadius:20,padding:"5px 12px",border:`1.5px solid ${active?"#2C1810":"#D4C4B0"}`}}>
              <input type="checkbox" checked={active} onChange={()=>setIds(l=>l.includes(item.id)?l.filter(x=>x!==item.id):[...l,item.id])} style={{display:"none"}}/>
              {active?"✓ ":""}{item.name||item.groupName}{item.price!=null?` +฿${item.price}`:""}{item.amount!=null?` -฿${item.amount}`:""}
            </label>
          );
        })}
      </div>
    </Field>
  );
});

function ProdFormShell({initState,title,data,persist,onClose}){
  const [name,setName]=useState(initState.name||"");
  const [color,setColor]=useState(initState.color||PALETTE[4]);
  const [textColor,setTC]=useState(initState.textColor||"#FFF");
  const [catId,setCatId]=useState(initState.catId||data.categories[0]?.id||"");
  const [unit,setUnit]=useState(initState.unit||"");
  const [vars,setVars]=useState(initState.vars||[{id:"v1",name:"ปกติ",price:""}]);
  const [image,setImage]=useState(initState.image||null);
  const [linkedAddons,setLA]=useState(initState.linkedAddons||[]);
  const [linkedFreeOpts,setLF]=useState(initState.linkedFreeOpts||[]);
  const [linkedDiscounts,setLD]=useState(initState.linkedDiscounts||[]);
  const fr=useRef();

  const addons=data.addons||[], freeOpts=data.freeOpts||[], discounts=data.discounts||[];
  const aV=useCallback(()=>setVars(v=>[...v,{id:`v${uid()}`,name:"",price:""}]),[]);
  const rV=useCallback(id=>setVars(v=>v.filter(x=>x.id!==id)),[]);
  const uV=useCallback((id,f,val)=>setVars(v=>v.map(x=>x.id===id?{...x,[f]:val}:x)),[]);
  const ip=useCallback(e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>setImage(ev.target.result);r.readAsDataURL(f);},[]);

  // useCallback ป้องกัน save re-create ทุก render → ปุ่มบันทึกตอบสนองทันที
  const save=useCallback(()=>{
    if(!name.trim()&&!catId)return;
    const vts=vars.filter(v=>v.name.trim()&&v.price!=="").map(v=>({...v,price:parseFloat(v.price)}));
    if(!vts.length)return;
    const prod={id:initState.id||`p${uid()}`,categoryId:catId,name:name.trim(),color,textColor,image,unit,variants:vts,linkedAddons,linkedFreeOpts,linkedDiscounts,order:initState.order??data.products.filter(p=>p.categoryId===catId).length};
    if(initState.id) persist({...data,products:data.products.map(p=>p.id===initState.id?prod:p)},true);
    else persist({...data,products:[...data.products,prod]},true);
    onClose();
  },[name,catId,vars,color,textColor,image,unit,linkedAddons,linkedFreeOpts,linkedDiscounts,initState,data,persist,onClose]);

  return(<div>
    <ModalTitle>{title}</ModalTitle>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
      <Field label="ชื่อสินค้า"><input value={name} onChange={e=>setName(e.target.value)} placeholder="เช่น ลาเต้" style={iStyle}/></Field>
      <Field label="หมวดหมู่"><select value={catId} onChange={e=>setCatId(e.target.value)} style={iStyle}>{data.categories.slice().sort((a,b)=>a.order-b.order).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    </div>
    <Field label={<span>หน่วยนับ <span style={{color:"#C84B4B"}}>*</span></span>}><input value={unit} onChange={e=>setUnit(e.target.value)} placeholder="เช่น แก้ว, ชิ้น" style={iStyle}/></Field>
    <Field label="สีพื้นหลัง"><ColorPicker value={color} onChange={setColor}/></Field>
    <Field label="สีตัวอักษร">
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <button onClick={()=>setTC("#FFF")} style={{flex:1,padding:"8px",borderRadius:9,border:`2px solid ${textColor==="#FFF"?"#2C1810":"#D4C4B0"}`,background:textColor==="#FFF"?"#2C1810":"#F0E8DC",color:textColor==="#FFF"?"#FFF":"#5C4A36",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:600}}>สีขาว</button>
        <button onClick={()=>setTC("#3B1F0A")} style={{flex:1,padding:"8px",borderRadius:9,border:`2px solid ${textColor==="#3B1F0A"?"#2C1810":"#D4C4B0"}`,background:textColor==="#3B1F0A"?"#EDE6DC":"#F0E8DC",color:"#3B1F0A",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:600}}>น้ำตาลเข้ม</button>
      </div>
      <div style={{background:color,borderRadius:12,padding:"14px",textAlign:"center",fontSize:15,fontWeight:700,color:textColor}}>{name||"ตัวอย่างสินค้า"}</div>
    </Field>
    <Field label="ภาพ (ไม่บังคับ)">
      <div style={{display:"flex",gap:9,alignItems:"center"}}>
        {image&&<img src={image} alt="" style={{width:42,height:42,borderRadius:9,objectFit:"cover"}}/>}
        <button onClick={()=>fr.current?.click()} style={{background:"#F0E8DC",border:"1px solid #D4C4B0",borderRadius:8,padding:"6px 13px",fontSize:13,cursor:"pointer",color:"#5C4A36",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}><Camera size={12}/> เลือกภาพ</button>
        <input ref={fr} type="file" accept="image/*" style={{display:"none"}} onChange={ip}/>
        {image&&<button onClick={()=>setImage(null)} style={{background:"none",border:"none",color:"#C84B4B",cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>ลบ</button>}
      </div>
    </Field>
    <Field label="รูปแบบและราคา">
      <div style={{display:"flex",flexDirection:"column",gap:7}}>
        {vars.map(v=>(
          <div key={v.id} style={{display:"flex",gap:8,alignItems:"center"}}>
            <input value={v.name} onChange={e=>uV(v.id,"name",e.target.value)} placeholder="เช่น ร้อน" style={{...iStyle,flex:2}}/>
            <input value={v.price} onChange={e=>uV(v.id,"price",e.target.value)} placeholder="฿" type="number" style={{...iStyle,flex:1}}/>
            {vars.length>1&&<button onClick={()=>rV(v.id)} style={{background:"#FDE8E8",border:"none",borderRadius:7,padding:"6px 8px",color:"#C84B4B",cursor:"pointer"}}><X size={12}/></button>}
          </div>
        ))}
        <button onClick={aV} style={{background:"none",border:"1px dashed #C4B4A0",borderRadius:8,padding:"7px",fontSize:13,color:"#8C7C6C",cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}><Plus size={12}/> เพิ่มรูปแบบ</button>
      </div>
    </Field>
    <CheckRow label={<span><Tag size={12} style={{display:"inline",marginRight:4,verticalAlign:"middle"}}/>Add-on ที่อนุญาต (บวกราคา)</span>} ids={linkedAddons} setIds={setLA} items={addons}/>
    <CheckRow label={<span><Gift size={12} style={{display:"inline",marginRight:4,verticalAlign:"middle"}}/>ตัวเลือกเสริมที่อนุญาต</span>} ids={linkedFreeOpts} setIds={setLF} items={freeOpts}/>
    <CheckRow label={<span><Percent size={12} style={{display:"inline",marginRight:4,verticalAlign:"middle"}}/>ส่วนลดที่อนุญาต</span>} ids={linkedDiscounts} setIds={setLD} items={discounts}/>
    <ModalFooter onCancel={onClose} onSave={save}/>
  </div>);
}
function AddProdModal({data,persist,catId,onClose}){ return <ProdFormShell initState={{catId:catId||data.categories[0]?.id}} title="เพิ่มสินค้า" data={data} persist={persist} onClose={onClose}/>; }
function EditProdModal({prod,data,persist,onClose}){ return <ProdFormShell initState={{...prod,catId:prod.categoryId,vars:prod.variants.map(v=>({...v,price:String(v.price)}))}} title="แก้ไขสินค้า" data={data} persist={persist} onClose={onClose}/>; }
function AddCatModal({data,persist,onClose}){
  const [name,setName]=useState(""); const [color,setColor]=useState(PALETTE[0]); const [textColor,setTC]=useState("#FFF");
  return(<div><ModalTitle>➕ เพิ่มหมวดหมู่</ModalTitle><Field label="ชื่อ"><input value={name} onChange={e=>setName(e.target.value)} placeholder="เช่น กาแฟ" style={iStyle}/></Field><Field label="สีพื้นหลัง"><ColorPicker value={color} onChange={setColor}/></Field><Field label="สีตัวอักษร"><div style={{display:"flex",gap:8}}><button onClick={()=>setTC("#FFF")} style={{flex:1,padding:"8px",borderRadius:9,border:`2px solid ${textColor==="#FFF"?"#2C1810":"#D4C4B0"}`,background:textColor==="#FFF"?"#2C1810":"#F0E8DC",color:textColor==="#FFF"?"#FFF":"#5C4A36",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:600}}>สีขาว</button><button onClick={()=>setTC("#3B1F0A")} style={{flex:1,padding:"8px",borderRadius:9,border:`2px solid ${textColor==="#3B1F0A"?"#2C1810":"#D4C4B0"}`,background:textColor==="#3B1F0A"?"#EDE6DC":"#F0E8DC",color:"#3B1F0A",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:600}}>น้ำตาลเข้ม</button></div><div style={{marginTop:8,background:color,borderRadius:9,padding:"10px",textAlign:"center",fontSize:14,fontWeight:700,color:textColor}}>ตัวอย่าง: {name||"หมวดหมู่"}</div></Field><ModalFooter onCancel={onClose} onSave={()=>{if(!name.trim())return;persist({...data,categories:[...data.categories,{id:`cat${uid()}`,name:name.trim(),color,textColor,order:data.categories.length}]},true);onClose();}}/></div>);
}
function EditCatModal({cat,data,persist,onClose}){
  const [name,setName]=useState(cat.name); const [color,setColor]=useState(cat.color); const [textColor,setTC]=useState(cat.textColor||"#FFF");
  return(<div><ModalTitle>✏️ แก้ไขหมวดหมู่</ModalTitle><Field label="ชื่อ"><input value={name} onChange={e=>setName(e.target.value)} style={iStyle}/></Field><Field label="สีพื้นหลัง"><ColorPicker value={color} onChange={setColor}/></Field><Field label="สีตัวอักษร"><div style={{display:"flex",gap:8}}><button onClick={()=>setTC("#FFF")} style={{flex:1,padding:"8px",borderRadius:9,border:`2px solid ${textColor==="#FFF"?"#2C1810":"#D4C4B0"}`,background:textColor==="#FFF"?"#2C1810":"#F0E8DC",color:textColor==="#FFF"?"#FFF":"#5C4A36",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:600}}>สีขาว</button><button onClick={()=>setTC("#3B1F0A")} style={{flex:1,padding:"8px",borderRadius:9,border:`2px solid ${textColor==="#3B1F0A"?"#2C1810":"#D4C4B0"}`,background:textColor==="#3B1F0A"?"#EDE6DC":"#F0E8DC",color:"#3B1F0A",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:600}}>น้ำตาลเข้ม</button></div><div style={{marginTop:8,background:color,borderRadius:9,padding:"10px",textAlign:"center",fontSize:14,fontWeight:700,color:textColor}}>ตัวอย่าง: {name||"หมวดหมู่"}</div></Field><ModalFooter onCancel={onClose} onSave={()=>{if(!name.trim())return;persist({...data,categories:data.categories.map(c=>c.id===cat.id?{...c,name:name.trim(),color,textColor}:c)},true);onClose();}}/></div>);
}

// ══════════════════════════════════════════════════
// REPORT VIEW
// ══════════════════════════════════════════════════
function ReportView({data,dispDate,onVoid,onHardDelete,rcpt,costs,setCosts,onLedgerCommit,ctof,ledger}){
  const [from,setFrom]=useState(dispDate),[to,setTo]=useState(dispDate);
  const [selCats,setSel]=useState([]),[histOpen,setHist]=useState(false);
  const [confModal,setConf]=useState(null),[commitConfirm,setCmtConf]=useState(null);
  const [consolCost,setConsol]=useState("");
  const sc=data.categories.slice().sort((a,b)=>a.order-b.order);
  const today=todayStr();

  const todayOrders=data.orders.filter(o=>o.date===today&&!o.isCanceled);
  let dashRev=0; todayOrders.forEach(o=>o.items.forEach(i=>{dashRev+=i.price*i.qty;}));
  const todayLdgr=ledger.filter(e=>e.type==="category"&&e.ts?.startsWith(today));
  const locked=todayLdgr.reduce((a,e)=>({cost:a.cost+(e.cost||0),profit:a.profit+(e.netProfit||0)}),{cost:0,profit:0});

  const pendOrders=data.orders.filter(o=>o.date===today&&!o.isCanceled);
  let pendRev=0,pendUnits=0;
  pendOrders.forEach(o=>o.items.forEach(item=>{
    const p=data.products.find(x=>x.id===item.productId); if(!p)return;
    const co=ctof[p.categoryId]||null;
    if(co&&new Date(o.ts)<=new Date(co))return;
    pendRev+=item.price*item.qty; pendUnits+=item.qty;
  }));

  const activeOrders=data.orders.filter(o=>o.date>=from&&o.date<=to&&!o.isCanceled);
  const catStats={};
  sc.forEach(cat=>{
    const cutoff=ctof[cat.id]||null;
    let rev=0,units=0,unitName="รายการ";
    activeOrders.filter(o=>!cutoff||new Date(o.ts)>new Date(cutoff)).forEach(o=>o.items.forEach(item=>{
      const p=data.products.find(x=>x.id===item.productId); if(!p||p.categoryId!==cat.id)return;
      rev+=item.price*item.qty; units+=item.qty; if(p.unit)unitName=p.unit;
    }));
    catStats[cat.id]={cat,rev,units,unitName};
  });

  const allChecked=selCats.length===0||selCats.length===sc.length;
  const cids=selCats.length===0?sc.map(c=>c.id):selCats;
  const selList=Object.values(catStats).filter(s=>cids.includes(s.cat.id));
  const selRev=selList.reduce((a,s)=>a+s.rev,0);
  const selUnits=selList.reduce((a,s)=>a+s.units,0);
  const selUnitName=selList.length===1?selList[0].unitName:"รายการ";
  const cpu=parseFloat(consolCost)||0;
  const parsedCost=cpu*selUnits;
  const selProfit=selRev-parsedCost;
  const toggleCat=id=>setSel(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);

  function handleCommit(){
    const tc=selList.filter(s=>s.rev>0); if(!tc.length||selRev===0)return;
    setCmtConf({items:tc,totalRev:selRev,totalCost:parsedCost,totalProfit:selProfit,totalUnits:selUnits,unitName:selUnitName});
  }
  function doCommit(){
    if(!commitConfirm)return;
    const ts=new Date().toISOString(); const catIds=commitConfirm.items.map(s=>s.cat.id);
    const entry={type:"category",catIds,catName:commitConfirm.items.map(s=>s.cat.name).join(", "),date:dispDate,units:commitConfirm.totalUnits,unitName:commitConfirm.unitName||"รายการ",revenue:commitConfirm.totalRev,cost:commitConfirm.totalCost,netProfit:commitConfirm.totalProfit};
    const p={}; catIds.forEach(id=>{p[id]=ts;});
    onLedgerCommit(entry,p); setCmtConf(null); setConsol("");
  }

  const allOrders=data.orders.filter(o=>o.date>=from&&o.date<=to);
  return(
    <div style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
      <div style={{fontWeight:700,fontSize:19,color:"#2C1810",marginBottom:16,display:"flex",alignItems:"center",gap:8}}><BarChart2 size={19}/> รายงานยอดขาย</div>

      {/* Daily Dashboard */}
      <div style={{background:"#2C1810",borderRadius:14,padding:"16px 18px",marginBottom:20}}>
        <div style={{fontSize:12,color:"#C8A882",marginBottom:10,fontWeight:600,display:"flex",justifyContent:"space-between"}}>
          <span>📊 ผลงานวันนี้ — {fmtDate(today)}</span><span style={{fontSize:10,color:"rgba(255,255,255,.4)"}}>ทุน/กำไร = เฉพาะที่บันทึกแล้ว</span>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:pendRev>0?10:0}}>
          {[["ยอดขายรวม",baht(dashRev),"#D4A574"],["เงินทุน (บันทึกแล้ว)",baht(locked.cost),"#C87941"],["กำไร (บันทึกแล้ว)",baht(locked.profit),locked.profit>=0?"#6CC97A":"#C96C6C"]].map(([l,v,c])=>(
            <div key={l} style={{background:"rgba(255,255,255,.07)",borderRadius:10,padding:"12px",textAlign:"center"}}><div style={{fontSize:11,color:"rgba(255,255,255,.6)",marginBottom:4}}>{l}</div><div style={{fontSize:20,fontWeight:700,color:c}}>{v}</div></div>
          ))}
        </div>
        {pendRev>0&&<div style={{background:"rgba(255,255,255,.06)",borderRadius:9,padding:"7px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:10,color:"rgba(255,255,255,.5)"}}>⏳ รอบันทึกบัญชี ({pendUnits} รายการ)</span><span style={{fontSize:14,fontWeight:700,color:"#C8A882"}}>{baht(pendRev)}</span></div>}
      </div>

      {/* Calc Area */}
      <div style={{background:"#FFF8F2",border:"1px solid #E8D8C8",borderRadius:13,padding:18,marginBottom:18}}>
        <div style={{fontWeight:700,fontSize:14,color:"#2C1810",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <span>💰 พื้นที่คำนวณกำไร</span>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            {[["จาก",from,setFrom],["ถึง",to,setTo]].map(([l,v,s])=>(
              <label key={l} style={{display:"flex",alignItems:"center",gap:5,fontSize:12,color:"#5C4A36"}}>{l}<input type="date" value={v} onChange={e=>s(e.target.value)} style={{padding:"3px 8px",borderRadius:7,border:"1px solid #D4C4B0",background:"#F5F0EA",color:"#2C1810",fontSize:12}}/></label>
            ))}
            <button onClick={()=>{setFrom(dispDate);setTo(dispDate);}} style={{background:"#EDE6DC",border:"none",borderRadius:7,padding:"3px 10px",fontSize:12,color:"#5C4A36",cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:4}}><RefreshCw size={10}/> วันนี้</button>
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:12,color:"#8C7C6C",marginBottom:8,fontWeight:500}}>เลือกหมวดหมู่:</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            <label style={{display:"flex",alignItems:"center",gap:5,fontSize:13,cursor:"pointer",fontWeight:600,color:"#2C1810"}}><input type="checkbox" checked={allChecked} onChange={()=>setSel([])} style={{accentColor:"#2C1810",width:16,height:16}}/>ทั้งหมด</label>
            {sc.map(cat=>{const chk=selCats.length===0||selCats.includes(cat.id);const s=catStats[cat.id];return(
              <label key={cat.id} style={{display:"flex",alignItems:"center",gap:5,fontSize:13,cursor:"pointer"}}>
                <input type="checkbox" checked={chk} onChange={()=>toggleCat(cat.id)} style={{accentColor:cat.color,width:15,height:15}}/>
                <span style={{background:cat.color,color:"#FFF",borderRadius:10,padding:"2px 10px",fontSize:12,fontWeight:600}}>{cat.name}</span>
                {s?.rev>0&&<span style={{fontSize:11,color:"#8C7C6C"}}>{baht(s.rev)}</span>}
                {ctof[cat.id]&&<span style={{fontSize:10,color:"#B0A898"}}>📌{fmtDT(ctof[cat.id])}</span>}
              </label>
            );})}
          </div>
        </div>
        <div style={{background:"#F5F0EA",borderRadius:10,padding:"10px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <span style={{fontSize:13,color:"#2C1810",fontWeight:600}}>รวม {selUnits} {selUnitName} — {baht(selRev)}</span>
          <div style={{display:"flex",alignItems:"center",gap:6,marginLeft:"auto"}}>
            <span style={{fontSize:13,color:"#5C4A36"}}>ต้นทุน/หน่วย (฿)</span>
            <input type="number" value={consolCost} onChange={e=>setConsol(e.target.value)} placeholder="0" style={{width:90,padding:"5px 10px",borderRadius:8,border:"1px solid #D4C4B0",background:"#FFF",color:"#2C1810",fontSize:14,fontFamily:"inherit"}}/>
            <span style={{fontSize:12,color:"#8C7C6C"}}>× {selUnits} = {baht(parsedCost)}</span>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
          {[["ยอดขาย",baht(selRev),"#D4A574"],["เงินทุน",baht(parsedCost),"#C87941"],["กำไร",baht(selProfit),selProfit>=0?"#3A7A3A":"#C84B4B"]].map(([l,v,c])=>(
            <div key={l} style={{background:"#F5F0EA",borderRadius:11,padding:"12px",textAlign:"center"}}><div style={{fontSize:11,color:"#8C7C6C",marginBottom:4}}>{l}</div><div style={{fontSize:20,fontWeight:700,color:c}}>{v}</div></div>
          ))}
        </div>
        <button onClick={handleCommit} disabled={selRev===0} style={{width:"100%",background:selRev>0?"#2C1810":"#C0B0A0",color:"#FFF",border:"none",borderRadius:10,padding:"12px",fontSize:14,fontWeight:700,cursor:selRev>0?"pointer":"not-allowed",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
          <BookOpen size={15}/> บันทึกลงบัญชี (รีเซ็ตยอดที่เลือก)
        </button>
      </div>

      {/* Bar chart — อิสระจาก checkbox: ดึงจาก raw orders ทั้งหมดในช่วงวัน ไม่ filter cutoff */}
      {(()=>{
        const rawOrders=data.orders.filter(o=>o.date>=from&&o.date<=to&&!o.isCanceled);
        const raw=sc.map(cat=>{let rev=0,units=0,unitName="รายการ";rawOrders.forEach(o=>o.items.forEach(item=>{const p=data.products.find(x=>x.id===item.productId);if(!p||p.categoryId!==cat.id)return;rev+=item.price*item.qty;units+=item.qty;if(p.unit)unitName=p.unit;}));return{cat,rev,units,unitName};}).filter(s=>s.rev>0).sort((a,b)=>b.rev-a.rev);
        const rTot=raw.reduce((a,s)=>a+s.rev,0);
        if(!raw.length)return null;
        return(<div style={{background:"#FFF8F2",border:"1px solid #E8D8C8",borderRadius:13,padding:18,marginBottom:18}}>
          <div style={{fontWeight:700,fontSize:14,color:"#2C1810",marginBottom:12}}>ยอดขายตามหมวดหมู่</div>
          {raw.map(s=>(
            <div key={s.cat.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <div style={{width:11,height:11,borderRadius:3,background:s.cat.color,flexShrink:0}}/>
              <div style={{flex:1}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:3}}><span style={{fontWeight:600,color:"#2C1810"}}>{s.cat.name}</span><span style={{color:"#6B4F3A",fontWeight:700}}>{baht(s.rev)}</span></div>
                <div style={{background:"#EDE6DC",borderRadius:4,height:5}}><div style={{background:s.cat.color,height:"100%",width:`${rTot>0?(s.rev/rTot*100):0}%`,borderRadius:4}}/></div>
              </div>
              <span style={{fontSize:12,color:"#8C7C6C",minWidth:56,textAlign:"right"}}>{s.units} {s.unitName}</span>
            </div>
          ))}
        </div>);
      })()}

      {/* Order history */}
      <div style={{background:"#FFF8F2",border:"1px solid #E8D8C8",borderRadius:13,overflow:"hidden",marginBottom:18}}>
        <div onClick={()=>setHist(!histOpen)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",cursor:"pointer",background:"#F5EEE6"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,fontWeight:700,fontSize:14,color:"#2C1810"}}><Receipt size={16}/> ประวัติออเดอร์<span style={{background:"#2C1810",color:"#FFF",borderRadius:20,padding:"1px 10px",fontSize:11}}>{allOrders.length}</span>{allOrders.filter(o=>o.isCanceled).length>0&&<span style={{background:"#FDE8E8",color:"#C84B4B",borderRadius:20,padding:"1px 10px",fontSize:11}}>ยกเลิก {allOrders.filter(o=>o.isCanceled).length}</span>}</div>
          {histOpen?<ChevronUp size={16} color="#8C7C6C"/>:<ChevronDown size={16} color="#8C7C6C"/>}
        </div>
        {histOpen&&<div>
          {allOrders.length===0&&<div style={{textAlign:"center",color:"#9C8C7C",padding:"24px 0",fontSize:13}}>ไม่มีออเดอร์</div>}
          {/* จำกัดแสดง 5 รายการ scroll เฉพาะส่วน */}
          <div style={{maxHeight:420,overflowY:"auto",padding:"0 18px"}}>
            {[...allOrders].reverse().map(order=>(
              <div key={order.id} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0",borderBottom:"1px solid #EDE4DA",opacity:order.isCanceled?0.6:1}}>
                <div style={{width:4,borderRadius:4,alignSelf:"stretch",background:order.isCanceled?"#C84B4B":"#7A9E6B",flexShrink:0,minHeight:36}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}>
                    <span style={{background:order.isCanceled?"#FDE8E8":"#EDE6DC",color:order.isCanceled?"#C84B4B":"#6B4F3A",borderRadius:8,padding:"1px 8px",fontSize:12,fontWeight:700}}>{order.orderNum?fmtNum(order.orderNum):`#${order.id.slice(-4).toUpperCase()}`}</span>
                    <span style={{fontSize:11,color:"#9C8C7C"}}>{fmtDate(order.date)} {fmtTime(order.ts)}</span>
                    {!order.isCanceled&&(order.paymentMethod==="qr"?<span style={{background:"#EFF6FF",color:"#1D4ED8",borderRadius:8,padding:"1px 7px",fontSize:10,fontWeight:600}}>โอนจ่าย</span>:<span style={{background:"#F0FFF4",color:"#166534",borderRadius:8,padding:"1px 7px",fontSize:10,fontWeight:600}}>เงินสด</span>)}
                    {order.isCanceled&&<span style={{background:"#FDE8E8",color:"#C84B4B",borderRadius:10,padding:"1px 8px",fontSize:10,fontWeight:700}}>⊘ ยกเลิก</span>}
                  </div>
                  <div style={{fontSize:11,color:"#8C7C6C",marginBottom:3,textDecoration:order.isCanceled?"line-through":"none"}}>{order.items.map(i=>`${i.name}(${i.variant})${i.note?` [${i.note}]`:""}×${i.qty}`).join(" · ")}</div>
                  <div style={{fontSize:13,fontWeight:700,color:order.isCanceled?"#C84B4B":"#6B4F3A"}}>{baht(order.total)}</div>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:5,flexShrink:0}}>
                  {!order.isCanceled&&<button onClick={()=>setConf({type:"viewReceipt",order,rcpt})} style={{background:"#EDE6DC",border:"none",borderRadius:8,padding:"5px 9px",fontSize:11,color:"#6B4F3A",cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:3,whiteSpace:"nowrap"}}><Eye size={11}/> บิล</button>}
                  {!order.isCanceled&&<button onClick={()=>setConf({type:"void",id:order.id,orderNum:order.orderNum})} style={{background:"#FDE8E8",border:"none",borderRadius:8,padding:"5px 9px",fontSize:11,color:"#C84B4B",cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:3,whiteSpace:"nowrap"}}><Ban size={11}/> ยกเลิก</button>}
                </div>
              </div>
            ))}
          </div>
          {allOrders.length>5&&<div style={{textAlign:"center",fontSize:11,color:"#9C8C7C",padding:"8px 0",borderTop:"1px solid #EDE4DA"}}>เลื่อนเพื่อดูทั้งหมด {allOrders.length} รายการ</div>}
        </div>}
      </div>

      {confModal?.type==="void"&&<Overlay onClose={()=>setConf(null)}><ConfirmModal icon={<Ban size={36} color="#C84B4B" style={{margin:"0 auto 12px"}}/>} msg={`ยืนยันยกเลิกออเดอร์ ${confModal.orderNum?fmtNum(confModal.orderNum):""}?`} confirmLabel="ยืนยัน" confirmColor="#C84B4B" onConfirm={()=>{onVoid(confModal.id);setConf(null);}} onCancel={()=>setConf(null)}/></Overlay>}
      {confModal?.type==="viewReceipt"&&<Overlay onClose={()=>setConf(null)} wide><ChangeModal modal={{change:confModal.order.change,received:confModal.order.received,total:confModal.order.total,order:confModal.order,rcpt:confModal.rcpt}} onDismiss={()=>setConf(null)}/></Overlay>}
      {commitConfirm&&<Overlay onClose={()=>setCmtConf(null)}><div style={{textAlign:"center"}}>
        <BookOpen size={36} color="#2C1810" style={{margin:"0 auto 12px"}}/>
        <div style={{fontWeight:700,fontSize:16,color:"#2C1810",marginBottom:4}}>ยืนยันการบันทึกลงบัญชี</div>
        <div style={{fontSize:12,color:"#8C7C6C",marginBottom:16}}>หมวดที่เลือก: {commitConfirm.items.map(s=>s.cat.name).join(", ")}</div>
        <div style={{background:"#F5F0EA",borderRadius:12,padding:14,marginBottom:16}}>
          {commitConfirm.items.map(s=><div key={s.cat.id} style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:6}}><span style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:8,height:8,borderRadius:"50%",background:s.cat.color}}/>{s.cat.name} ({s.units} {s.unitName})</span><span style={{fontWeight:600,color:"#6B4F3A"}}>{baht(s.rev)}</span></div>)}
          <div style={{borderTop:"1px solid #D4C4B0",marginTop:8,paddingTop:8}}>
            {[["ยอดขายรวม",baht(commitConfirm.totalRev),"#D4A574"],["ต้นทุนรวม",baht(commitConfirm.totalCost),"#C87941"],["กำไรสุทธิ",baht(commitConfirm.totalProfit),commitConfirm.totalProfit>=0?"#3A7A3A":"#C84B4B"]].map(([l,v,c])=><div key={l} style={{display:"flex",justifyContent:"space-between",fontSize:14,fontWeight:700,marginBottom:4}}><span style={{color:"#5C4A36"}}>{l}</span><span style={{color:c}}>{v}</span></div>)}
          </div>
        </div>
        <div style={{fontSize:12,color:"#C87941",marginBottom:16}}>⚠️ ยอดของหมวดที่เลือกจะรีเซ็ตเป็น 0 ทันที</div>
        <div style={{display:"flex",gap:10}}><button onClick={()=>setCmtConf(null)} style={{flex:1,background:"#F0E8DC",color:"#5C4A36",border:"none",borderRadius:10,padding:"11px",fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>ยกเลิก</button><button onClick={doCommit} style={{flex:1,background:"#2C1810",color:"#FFF",border:"none",borderRadius:10,padding:"11px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>✅ ยืนยัน</button></div>
      </div></Overlay>}
    </div>
  );
}

// ══════════════════════════════════════════════════
// LEDGER VIEW
// ══════════════════════════════════════════════════
const TX_INFO = {
  category:   {label:"บันทึกยอดขาย",  color:"#7A9E6B"},
  initial:    {label:"ตั้งค่าเงินเริ่มต้น",color:"#4179C8"},
  expense:    {label:"จ่ายทุน",        color:"#C87941"},
  withdrawal: {label:"ถอนกำไร",        color:"#7941C8"},
};

function LedgerView({ledger,cash,data,dispDate,onUndoEntry,onAddCashTx}){
  const [ld,setLd]=useState(dispDate);
  const [cm,setCm]=useState(null);
  const [cu,setCu]=useState(null);

  const cashTxAll=ledger.filter(e=>["initial","expense","withdrawal"].includes(e.type)).sort((a,b)=>new Date(b.ts)-new Date(a.ts));
  const dayEntries=ledger.filter(e=>(e.ts?.startsWith(ld))||e.date===ld).sort((a,b)=>new Date(b.ts)-new Date(a.ts));
  const ds=dayEntries.reduce((a,e)=>{
    if(e.type==="category"){a.revenue+=(e.revenue||0);a.cost+=(e.cost||0);a.profit+=(e.netProfit||0);a.units+=(e.units||0);}
    if(e.type==="expense")a.expense+=(e.amount||0);
    if(e.type==="withdrawal")a.withdrawal+=(e.amount||0);
    return a;
  },{revenue:0,cost:0,profit:0,units:0,expense:0,withdrawal:0});

  return(
    <div style={{display:"flex",flex:1,height:"calc(100vh - 64px)",overflow:"hidden"}}>

      {/* LEFT — scrollable, padded right so content doesn't hide under fixed sidebar */}
      <div style={{flex:1,height:"100%",overflowY:"auto",padding:"20px 18px",paddingRight:"calc(40% + 18px)",borderRight:"none",background:"#F5F0EA"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
          <div style={{fontWeight:700,fontSize:18,color:"#2C1810",display:"flex",alignItems:"center",gap:7}}><BookOpen size={19} color="#D4A574"/> รายการบัญชี</div>
          <div style={{flex:1}}/>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:"#5C4A36"}}><CalendarDays size={13}/><input type="date" value={ld} onChange={e=>setLd(e.target.value)} style={{padding:"4px 8px",borderRadius:8,border:"1px solid #D4C4B0",background:"#FFF8F2",color:"#2C1810",fontSize:13}}/></label>
        </div>
        {dayEntries.length===0?<EmptyMsg label="ยังไม่มีรายการบัญชีในวันนี้"/>:(
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {dayEntries.map(e=>{
              const info=TX_INFO[e.type]||{label:e.type,color:"#8C7C6C"};
              return(
                <div key={e.id} style={{background:"#FFF8F2",border:"1px solid #E8D8C8",borderRadius:12,padding:"10px 14px",display:"flex",alignItems:"flex-start",gap:10}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:info.color,flexShrink:0,marginTop:6}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,flexWrap:"wrap"}}>
                      <span style={{fontWeight:700,fontSize:13,color:"#2C1810"}}>{e.type==="category"?(e.catName||"หมวดรวม"):info.label}</span>
                      <span style={{fontSize:11,color:"#9C8C7C"}}>{fmtTime(e.ts)}</span>
                      <span style={{fontSize:10,background:"#F0E8DC",color:"#6B4F3A",borderRadius:8,padding:"1px 7px"}}>{info.label}</span>
                    </div>
                    {e.type==="category"&&<div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                      {[["จำนวน",`${e.units||0} ${e.unitName||"รายการ"}`,"#6B4F3A"],["ยอดขาย",baht(e.revenue),"#D4A574"],["ทุน",baht(e.cost),"#C87941"],["กำไร",baht(e.netProfit),(e.netProfit||0)>=0?"#3A7A3A":"#C84B4B"]].map(([l,v,c])=>(
                        <div key={l} style={{background:"#F5F0EA",borderRadius:7,padding:"5px 8px",textAlign:"center"}}><div style={{fontSize:10,color:"#8C7C6C"}}>{l}</div><div style={{fontSize:13,fontWeight:700,color:c}}>{v}</div></div>
                      ))}
                    </div>}
                    {e.type==="initial"&&<div style={{fontSize:13,color:"#4179C8",fontWeight:600}}>ทุน {baht(e.capital)} · กำไร {baht(e.profit)}</div>}
                    {e.type==="expense"&&<div style={{fontSize:13,color:"#C87941",fontWeight:700}}>จ่ายทุน: {baht(e.amount)}{e.desc?<span style={{color:"#8C7C6C",fontWeight:400}}> — {e.desc}</span>:""}</div>}
                    {e.type==="withdrawal"&&<div style={{fontSize:13,color:"#7941C8",fontWeight:700}}>ถอนกำไร: {baht(e.amount)}</div>}
                  </div>
                  <button onClick={()=>setCu(e)} style={{background:"#FDE8E8",border:"none",borderRadius:8,padding:"5px 8px",cursor:"pointer",color:"#C84B4B",flexShrink:0,display:"flex",alignItems:"center",gap:3,fontSize:11,fontFamily:"inherit"}}><Undo2 size={11}/> ยกเลิก</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* RIGHT — fixed to viewport, never scrolls with left */}
      <div style={{position:"fixed",top:64,right:0,width:"40%",height:"calc(100vh - 64px)",overflowY:"auto",background:"#FFF8F2",borderLeft:"1px solid #E4D4C0",padding:"20px 16px",paddingTop:"24px",display:"flex",flexDirection:"column",gap:12}}>

          {/* 1. สรุปยอดรายวัน (ย้ายมาจากฝั่งซ้าย — อยู่บนสุด) */}
          <div style={{background:"#2C1810",borderRadius:13,padding:"14px 16px"}}>
            <div style={{fontWeight:700,fontSize:13,color:"#D4A574",marginBottom:10}}>สรุปยอดรายวัน — {fmtDateS(ld)}</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:(ds.expense>0||ds.withdrawal>0)?8:0}}>
              {[["ยอดขาย",baht(ds.revenue),"#D4A574"],["ทุน",baht(ds.cost),"#C87941"],["กำไร",baht(ds.profit),ds.profit>=0?"#6CC97A":"#C96C6C"]].map(([l,v,c])=>(
                <div key={l} style={{background:"rgba(255,255,255,.07)",borderRadius:9,padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:10,color:"rgba(255,255,255,.6)"}}>{l}</div><div style={{fontSize:16,fontWeight:700,color:c}}>{v}</div></div>
              ))}
            </div>
            {(ds.expense>0||ds.withdrawal>0)&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div style={{background:"rgba(255,255,255,.07)",borderRadius:9,padding:"7px 10px",textAlign:"center"}}><div style={{fontSize:10,color:"rgba(255,255,255,.6)"}}>รายจ่าย</div><div style={{fontSize:15,fontWeight:700,color:"#C87941"}}>-{baht(ds.expense)}</div></div>
              <div style={{background:"rgba(255,255,255,.07)",borderRadius:9,padding:"7px 10px",textAlign:"center"}}><div style={{fontSize:10,color:"rgba(255,255,255,.6)"}}>ถอนกำไร</div><div style={{fontSize:15,fontWeight:700,color:"#7941C8"}}>-{baht(ds.withdrawal)}</div></div>
            </div>}
          </div>

          {/* 2. หัวข้อ */}
          <div style={{fontWeight:700,fontSize:16,color:"#2C1810",display:"flex",alignItems:"center",gap:7}}><Wallet size={17} color="#D4A574"/> บริหารเงินสด</div>

          {/* 3. ยอดเงินรวม */}
          <div style={{background:"#2C1810",borderRadius:14,padding:"16px",textAlign:"center"}}>
            <div style={{fontSize:12,color:"#C8A882",marginBottom:6}}>ยอดเงินรวม (ทุน + กำไร)</div>
            <div style={{fontSize:32,fontWeight:700,color:"#D4A574"}}>{baht(cash.total)}</div>
          </div>

          {/* 4. เงินทุน / กำไรสะสม */}
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {[["เงินทุนคงเหลือ",cash.capital,"#C87941",<PiggyBank size={16}/>],["กำไรสะสม",cash.profit,cash.profit>=0?"#3A7A3A":"#C84B4B",<ArrowUpCircle size={16}/>]].map(([l,v,c,ic])=>(
              <div key={l} style={{background:"#F5F0EA",border:"1px solid #E8D8C8",borderRadius:13,padding:"12px 14px",display:"flex",alignItems:"center",gap:12}}>
                <div style={{color:c}}>{ic}</div><div style={{flex:1}}><div style={{fontSize:11,color:"#8C7C6C"}}>{l}</div><div style={{fontSize:22,fontWeight:700,color:c}}>{baht(v)}</div></div>
              </div>
            ))}
          </div>

          {/* 5. ปุ่มดำเนินการ */}
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <button onClick={()=>setCm("init")}       style={{background:"#2C1810",color:"#FFF",border:"none",borderRadius:11,padding:"11px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><Settings size={14}/> ตั้งค่าเงินเริ่มต้น</button>
            <button onClick={()=>setCm("expense")}    style={{background:"#C87941",color:"#FFF",border:"none",borderRadius:11,padding:"11px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><ArrowDownCircle size={14}/> จ่ายทุน (Expense)</button>
            <button onClick={()=>setCm("withdrawal")} style={{background:"#7941C8",color:"#FFF",border:"none",borderRadius:11,padding:"11px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><ArrowUpCircle size={14}/> ถอนกำไร (Withdrawal)</button>
          </div>

      </div>

      {cm==="init"       &&<Overlay onClose={()=>setCm(null)}><CashInitModal onClose={()=>setCm(null)} onSave={(cap,prof)=>{onAddCashTx({type:"initial",capital:cap,profit:prof,date:dispDate});setCm(null);}}/></Overlay>}
      {cm==="expense"    &&<Overlay onClose={()=>setCm(null)}><ExpenseModal   onClose={()=>setCm(null)} onSave={(amt,desc)=>{onAddCashTx({type:"expense",amount:amt,desc,date:dispDate});setCm(null);}}/></Overlay>}
      {cm==="withdrawal" &&<Overlay onClose={()=>setCm(null)}><WithdrawalModal onClose={()=>setCm(null)} onSave={amt=>{onAddCashTx({type:"withdrawal",amount:amt,date:dispDate});setCm(null);}}/></Overlay>}
      {cu&&<Overlay onClose={()=>setCu(null)}><ConfirmModal icon={<Undo2 size={36} color="#C84B4B" style={{margin:"0 auto 12px"}}/>} msg={`ยืนยันการยกเลิกรายการ "${TX_INFO[cu.type]?.label||cu.type}"?\n\nยอดเงินจะถูกคืนกลับอัตโนมัติ`} confirmLabel="ยืนยัน" confirmColor="#C84B4B" onConfirm={()=>{onUndoEntry(cu.id);setCu(null);}} onCancel={()=>setCu(null)}/></Overlay>}
    </div>
  );
}

// ── Cash sub-modals ──
function CashInitModal({onSave,onClose}){
  const [cap,setCap]=useState(""); const [prof,setProf]=useState("");
  return<div><ModalTitle>💰 ตั้งค่าเงินเริ่มต้น</ModalTitle><div style={{fontSize:13,color:"#8C7C6C",marginBottom:14}}>กรอกยอดเงินทุนและกำไรที่มีอยู่</div><Field label="ยอดเงินทุน (฿)"><input type="number" value={cap} onChange={e=>setCap(e.target.value)} placeholder="0" style={iStyle}/></Field><Field label="ยอดกำไรสะสม (฿)"><input type="number" value={prof} onChange={e=>setProf(e.target.value)} placeholder="0" style={iStyle}/></Field><ModalFooter onCancel={onClose} onSave={()=>onSave(parseFloat(cap)||0,parseFloat(prof)||0)}/></div>;
}
function ExpenseModal({onSave,onClose}){
  const [amt,setAmt]=useState(""); const [desc,setDesc]=useState("");
  return<div><ModalTitle>💸 จ่ายทุน</ModalTitle><Field label="จำนวนเงิน (฿)"><input type="number" value={amt} onChange={e=>setAmt(e.target.value)} placeholder="0" style={iStyle}/></Field><Field label="รายละเอียด"><input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="เช่น ซื้อวัตถุดิบ" style={iStyle}/></Field><ModalFooter onCancel={onClose} onSave={()=>{if(!amt||parseFloat(amt)<=0)return;onSave(parseFloat(amt),desc);}}/></div>;
}
function WithdrawalModal({onSave,onClose}){
  const [amt,setAmt]=useState("");
  return<div><ModalTitle>💰 ถอนกำไร</ModalTitle><Field label="จำนวนเงินที่ถอน (฿)"><input type="number" value={amt} onChange={e=>setAmt(e.target.value)} placeholder="0" style={iStyle}/></Field><ModalFooter onCancel={onClose} onSave={()=>{if(!amt||parseFloat(amt)<=0)return;onSave(parseFloat(amt));}}/></div>;
}

// ══════════════════════════════════════════════════
// RECEIPT SETTINGS
// ══════════════════════════════════════════════════
function ReceiptSettingsView({settings,onSave,onClearData}){
  const [form,setForm]=useState({...settings}); const [saved,setSaved]=useState(false);
  const [showClear,setShowClear]=useState(false);
  const [pin,setPin]=useState(""); const [pinErr,setPinErr]=useState(false);
  const logoRef=useRef();
  const upd=(k,v)=>setForm(f=>({...f,[k]:v}));

  function handleClear(){
    if(pin.trim().toUpperCase()==="CLEARDATA"){
      onClearData(); setShowClear(false); setPin(""); setPinErr(false);
    } else { setPinErr(true); setTimeout(()=>setPinErr(false),2000); }
  }

  // Demo QR payload for preview
  const previewQR = form.promptpay
    ? generatePromptPayQR(form.promptpay, 85)
    : "";

  return(
    <div style={{flex:1,overflow:"hidden",height:"calc(100vh - 64px)",display:"flex"}}>

      {/* ── LEFT: Form ── */}
      <div style={{width:420,height:"100%",overflowY:"auto",padding:"24px 20px",borderRight:"1px solid #E4D4C0",background:"#F5F0EA",flexShrink:0}}>
        <div style={{fontWeight:700,fontSize:18,color:"#2C1810",marginBottom:18,display:"flex",alignItems:"center",gap:8}}><Settings size={18}/> ตั้งค่าใบเสร็จ</div>

        <div style={{background:"#FFF8F2",border:"1px solid #E8D8C8",borderRadius:14,padding:20,display:"flex",flexDirection:"column",gap:13,marginBottom:16}}>
          {/* Logo */}
          <Field label="โลโก้ร้าน">
            <div style={{display:"flex",gap:12,alignItems:"center"}}>
              {form.logo&&<img src={form.logo} alt="logo" style={{width:52,height:52,borderRadius:9,objectFit:"contain",background:"#F5F0EA",padding:3}}/>}
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <button onClick={()=>logoRef.current?.click()} style={{background:"#F0E8DC",border:"1px solid #D4C4B0",borderRadius:8,padding:"6px 12px",fontSize:13,cursor:"pointer",color:"#5C4A36",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}><Camera size={12}/> อัปโหลดโลโก้</button>
                {form.logo&&<button onClick={()=>upd("logo",null)} style={{background:"none",border:"none",color:"#C84B4B",cursor:"pointer",fontSize:12,fontFamily:"inherit",textAlign:"left"}}>ลบโลโก้</button>}
              </div>
              <input ref={logoRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>upd("logo",ev.target.result);r.readAsDataURL(f);}}/>
            </div>
          </Field>
          <Field label="ชื่อร้าน"><input value={form.shopName} onChange={e=>upd("shopName",e.target.value)} style={iStyle}/></Field>
          <Field label="ที่อยู่ร้าน"><input value={form.address||""} onChange={e=>upd("address",e.target.value)} placeholder="เช่น 123/45 ถ.สุขุมวิท" style={iStyle}/></Field>
          <Field label="ช่องทางติดต่อ (Line / โทร)"><input value={form.contact||""} onChange={e=>upd("contact",e.target.value)} placeholder="เช่น Line: @roomtwocoffee" style={iStyle}/></Field>
          <Field label="ชื่อพนักงาน"><input value={form.staffName||""} onChange={e=>upd("staffName",e.target.value)} placeholder="เช่น น้องมิ้ว" style={iStyle}/></Field>
          <Field label="ข้อความขอบคุณ"><input value={form.thankMsg} onChange={e=>upd("thankMsg",e.target.value)} style={iStyle}/></Field>
        </div>

        {/* PromptPay */}
        <div style={{background:"#FFF8F2",border:"1px solid #E8D8C8",borderRadius:14,padding:20,display:"flex",flexDirection:"column",gap:13,marginBottom:16}}>
          <div style={{fontWeight:600,fontSize:14,color:"#2C1810",display:"flex",alignItems:"center",gap:6}}>💳 PromptPay</div>
          <Field label="หมายเลขพร้อมเพย์"><input value={form.promptpay||""} onChange={e=>upd("promptpay",e.target.value)} placeholder="เบอร์โทร หรือ เลขบัตรประชาชน" style={iStyle}/></Field>
          <Field label="ชื่อบัญชี"><input value={form.accountName||""} onChange={e=>upd("accountName",e.target.value)} placeholder="เช่น นาย สมชาย ใจดี" style={iStyle}/></Field>
        </div>

        <button onClick={()=>{onSave(form);setSaved(true);setTimeout(()=>setSaved(false),2000);}}
          style={{width:"100%",background:"#2C1810",color:"#FFF",border:"none",borderRadius:11,padding:"12px",fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:7,marginBottom:16}}>
          {saved?<><CheckCircle size={16}/> บันทึกแล้ว!</>:"บันทึกการตั้งค่า"}
        </button>

        {/* Danger zone */}
        <div style={{background:"#FFF8F2",border:"1px solid #FCA5A5",borderRadius:14,padding:18}}>
          <div style={{fontWeight:600,fontSize:13,color:"#C84B4B",marginBottom:4}}>โซนอันตราย</div>
          <div style={{fontSize:12,color:"#8C7C6C",marginBottom:12,lineHeight:1.6}}>ล้างประวัติการขายและบัญชีทั้งหมด<br/>เมนูสินค้าและการตั้งค่าจะยังคงอยู่ครบ</div>
          {!showClear
            ?<button onClick={()=>setShowClear(true)} style={{background:"#FDE8E8",color:"#C84B4B",border:"1px solid #FCA5A5",borderRadius:9,padding:"8px 16px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>ล้างประวัติการขาย...</button>
            :<div>
              <div style={{fontSize:13,color:"#C84B4B",marginBottom:8,fontWeight:600}}>พิมพ์รหัสยืนยัน</div>
              <input value={pin} onChange={e=>{setPin(e.target.value);setPinErr(false);}} placeholder='พิมพ์ "CLEARDATA"' style={{...iStyle,marginBottom:8,border:`1px solid ${pinErr?"#C84B4B":"#D4C4B0"}`,background:pinErr?"#FFF0F0":"#F5F0EA"}}/>
              {pinErr&&<div style={{fontSize:12,color:"#C84B4B",marginBottom:8}}>รหัสไม่ถูกต้อง ลองใหม่</div>}
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{setShowClear(false);setPin("");setPinErr(false);}} style={{flex:1,background:"#F0E8DC",color:"#5C4A36",border:"none",borderRadius:9,padding:"9px",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>ยกเลิก</button>
                <button onClick={handleClear} style={{flex:1,background:"#C84B4B",color:"#FFF",border:"none",borderRadius:9,padding:"9px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>ยืนยัน</button>
              </div>
            </div>}
        </div>
      </div>

      {/* ── RIGHT: Live Preview ── */}
      <div style={{flex:1,height:"100%",overflowY:"auto",padding:"24px 28px",background:"#EDE6DC",display:"flex",flexDirection:"column",alignItems:"center"}}>
        <div style={{fontWeight:700,fontSize:15,color:"#6B4F3A",marginBottom:18,alignSelf:"flex-start"}}>ตัวอย่างบิล (Live Preview)</div>

        {/* Receipt paper */}
        <div style={{background:"#fff",borderRadius:12,boxShadow:"0 4px 24px rgba(0,0,0,.12)",padding:"24px 20px",width:"100%",maxWidth:360,fontFamily:"'Sarabun','Noto Sans Thai',sans-serif",color:"#000",textAlign:"center"}}>

          {/* Header */}
          {form.logo?<><img src={form.logo} alt="logo" style={{width:64,height:64,objectFit:"contain",margin:"0 auto 8px",display:"block"}}/><div style={{fontWeight:700,fontSize:16}}>{form.shopName||"ชื่อร้าน"}</div></>
            :<div style={{fontWeight:700,fontSize:20,letterSpacing:"0.03em"}}>{form.shopName||"ชื่อร้าน"}</div>}
          {form.staffName&&<div style={{fontSize:12,color:"#555",marginTop:2}}>พนักงาน: {form.staffName}</div>}
          {form.address&&<div style={{fontSize:11,color:"#555",marginTop:3}}>{form.address}</div>}
          {form.contact&&<div style={{fontSize:11,color:"#555",marginTop:2}}>{form.contact}</div>}
          <div style={{fontSize:12,color:"#555",marginTop:4}}>ใบเสร็จรับเงิน / Receipt</div>

          <div style={{borderTop:"1px dashed #ccc",margin:"10px 0"}}/>

          <div style={{textAlign:"left",fontSize:12,color:"#333",lineHeight:1.9}}>
            <div>เลขที่บิล: <b>#001</b></div>
            <div>วันที่: {fmtDate(todayStr())}</div>
            <div>เวลา: {fmtTime(new Date().toISOString())}</div>
          </div>

          <div style={{borderTop:"1px dashed #ccc",margin:"10px 0"}}/>

          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,textAlign:"left",tableLayout:"fixed"}}>
            <colgroup><col style={{width:"55%"}}/><col style={{width:"15%"}}/><col style={{width:"30%"}}/></colgroup>
            <thead><tr style={{borderBottom:"1px solid #ddd"}}><th style={{padding:"3px 0",fontWeight:600}}>รายการ</th><th style={{textAlign:"center",fontWeight:600}}>จำนวน</th><th style={{textAlign:"right",fontWeight:600}}>ราคา</th></tr></thead>
            <tbody>
              <tr><td style={{padding:"3px 0"}}>อเมริกาโน่ (เย็น)</td><td style={{textAlign:"center"}}>1 แก้ว</td><td style={{textAlign:"right",fontWeight:600}}>฿35</td></tr>
              <tr><td style={{padding:"3px 0"}}>ลาเต้ (ร้อน) <div style={{fontSize:10,color:"#888"}}>— หวานน้อย</div></td><td style={{textAlign:"center"}}>1 แก้ว</td><td style={{textAlign:"right",fontWeight:600}}>฿50</td></tr>
            </tbody>
          </table>

          <div style={{borderTop:"1px solid #ccc",marginTop:8,paddingTop:8}}>
            <div style={{display:"flex",justifyContent:"space-between",fontWeight:700,fontSize:15}}><span>ยอดรวม</span><span>฿85</span></div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#555",marginTop:3}}><span>วิธีชำระ</span><span style={{color:previewQR?"#1D4ED8":"#166534",fontWeight:600}}>{previewQR?"โอนจ่าย":"เงินสด"}</span></div>
          </div>

          {/* QR preview */}
          {previewQR&&<>
            <div style={{borderTop:"1px dashed #ccc",margin:"12px 0"}}/>
            <div style={{textAlign:"center"}}>
              {form.accountName&&<><div style={{fontSize:11,color:"#555",marginBottom:2}}>ชื่อบัญชี</div><div style={{fontSize:13,fontWeight:700,marginBottom:8}}>{form.accountName}</div></>}
              <QRCodeSVG value={previewQR} size={130} style={{display:"block",margin:"0 auto"}}/>
              <div style={{fontSize:16,fontWeight:700,marginTop:6}}>฿85</div>
              <div style={{fontSize:10,color:"#777",marginTop:2}}>สแกนชำระผ่าน PromptPay</div>
            </div>
          </>}

          <div style={{borderTop:"1px dashed #ccc",margin:"10px 0"}}/>
          <div style={{fontSize:12,color:"#444"}}>{form.thankMsg||"ขอบคุณที่ใช้บริการ"}</div>
          <div style={{fontSize:12,color:"#555",marginTop:3}}>★ {form.shopName||"ชื่อร้าน"} ★</div>
        </div>

        <div style={{fontSize:12,color:"#9C8C7C",marginTop:14,textAlign:"center"}}>ตัวอย่างใช้ยอดสมมติ ฿85<br/>QR จะ generate ตามยอดจริงเมื่อชำระเงิน</div>
      </div>
    </div>
  );
}
// ══════════════════════════════════════════════════
// PAYMENT & CHANGE MODALS
// ══════════════════════════════════════════════════
function PaymentModal({modal,setModal,cartTotal,onConfirm,onConfirmQR,rcpt}){
  const [disp,setDisp]=useState(modal.received||"");
  const rcv=parseInt(disp||"0",10);
  const press=v=>{
    if(v==="C"){setDisp("");setModal(m=>({...m,received:""}));return;}
    if(v==="⌫"){const n=disp.slice(0,-1);setDisp(n);setModal(m=>({...m,received:n}));return;}
    const n=disp+v; setDisp(n); setModal(m=>({...m,received:n}));
  };
  const sc=val=>{const n=String(rcv+val);setDisp(n);setModal(m=>({...m,received:n}));};
  const hasPromptpay=!!(rcpt?.promptpay);
  return(
    <div>
      <div style={{fontWeight:700,fontSize:16,color:"#2C1810",marginBottom:4}}>รับเงิน</div>
      <div style={{fontSize:13,color:"#8C7C6C",marginBottom:12}}>ยอดชำระ: {baht(cartTotal)}</div>
      {/* ปุ่ม QR ชำระ — เงินทอน 0 ทันที */}
      {hasPromptpay&&<button onClick={onConfirmQR}
        style={{width:"100%",background:"#4A7C6B",color:"#FFF",border:"none",borderRadius:12,padding:"13px",fontSize:16,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        📱 ชำระด้วย QR Code (เงินทอน ฿0)
      </button>}
      <div style={{background:"#F5F0EA",borderRadius:12,padding:"12px 14px",fontSize:26,fontWeight:700,color:"#2C1810",textAlign:"right",marginBottom:12,minHeight:52}}>{disp?baht(parseInt(disp,10)):<span style={{color:"#C0B0A0",fontSize:18}}>ใส่จำนวนเงิน (เงินสด)</span>}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:11}}>{[10,20,50,100,500,1000].map(v=><button key={v} onClick={()=>sc(v)} style={{flex:"1 1 74px",background:"#EDE6DC",border:"none",borderRadius:9,padding:"9px 4px",fontSize:14,fontWeight:600,color:"#6B4F3A",cursor:"pointer",fontFamily:"inherit"}}>+{v}</button>)}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>{["1","2","3","4","5","6","7","8","9","C","0","⌫"].map(v=><button key={v} onClick={()=>press(v)} style={{background:v==="C"?"#FDE8E8":v==="⌫"?"#F0E8DC":"#F5F0EA",border:"1px solid #E4D4C0",borderRadius:9,padding:"13px",fontSize:v==="⌫"?16:18,fontWeight:600,color:v==="C"?"#C84B4B":"#2C1810",cursor:"pointer",fontFamily:"inherit"}}>{v}</button>)}</div>
      {rcv>0&&rcv>=cartTotal&&<div style={{background:"#EDF7ED",border:"1px solid #A8D8A8",borderRadius:10,padding:"9px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{color:"#3A7A3A",fontSize:13}}>เงินทอน</span><span style={{color:"#2A6A2A",fontWeight:700,fontSize:18}}>{baht(rcv-cartTotal)}</span></div>}
      <button onClick={onConfirm} disabled={rcv<cartTotal} style={{width:"100%",background:rcv>=cartTotal?"#2C1810":"#C0B0A0",color:"#FFF",border:"none",borderRadius:12,padding:"13px",fontSize:16,fontWeight:700,cursor:rcv>=cartTotal?"pointer":"not-allowed",fontFamily:"inherit"}}>✅ ยืนยันรับเงินสด</button>
    </div>
  );
}

function ChangeModal({modal,onDismiss}){
  const [showR,setShowR]=useState(false); const [saving,setSaving]=useState(false);
  const receiptRef=useRef();
  const {order,rcpt={}}=modal;
  const shop=rcpt.shopName||"RoomTwo Coffee";
  const staff=rcpt.staffName||"";
  const thankMsg=rcpt.thankMsg||"ขอบคุณที่ใช้บริการ 🙏";
  const logo=rcpt.logo||null;
  const address=rcpt.address||"";
  const contact=rcpt.contact||"";
  const promptpay=rcpt.promptpay||"";
  const accountName=rcpt.accountName||"";
  const isChange=modal.change!==undefined&&modal.received!==undefined;

  // generate PromptPay payload inline — render ด้วย QRCodeSVG (ไม่ต้อง request ภายนอก)
  const qrPayload = (promptpay && order?.total)
    ? generatePromptPayQR(promptpay, order.total)
    : "";

  const saveJpg=async()=>{
    setSaving(true);await new Promise(r=>setTimeout(r,400));
    try{if(window.html2canvas&&receiptRef.current){const c=await window.html2canvas(receiptRef.current,{backgroundColor:"#ffffff",scale:2.5,useCORS:true,logging:false});const a=document.createElement("a");a.download=`receipt-${order?.orderNum?String(order.orderNum).padStart(3,"0"):order?.id?.slice(-4)||"x"}-${order?.date||"x"}.jpg`;a.href=c.toDataURL("image/jpeg",.92);a.click();}}catch(e){}
    setSaving(false);
  };

  return(
    <div style={{textAlign:"center",padding:"4px 0"}}>
      {isChange&&<><div style={{fontSize:44,marginBottom:10}}>✅</div><div style={{fontWeight:700,fontSize:17,color:"#2C1810",marginBottom:4}}>ชำระเงินสำเร็จ</div><div style={{fontSize:12,color:"#8C7C6C",marginBottom:18}}>รับ {baht(modal.received)} · ยอด {baht(modal.total)}</div><div style={{background:"#F5F0EA",borderRadius:14,padding:"18px 22px",marginBottom:18}}><div style={{fontSize:13,color:"#8C7C6C",marginBottom:4}}>เงินทอน</div><div style={{fontSize:44,fontWeight:700,color:"#2C1810"}}>{baht(modal.change)}</div></div></>}

      <div style={{display:"flex",gap:10,marginBottom:showR?16:0}}>
        <button onClick={()=>setShowR(!showR)} style={{flex:1,background:"#EDE6DC",color:"#5C4A36",border:"none",borderRadius:12,padding:"12px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          <Eye size={14}/>{showR?"ซ่อนบิล":"ดูบิล"}
        </button>
        <button onClick={onDismiss} style={{flex:1,background:"#2C1810",color:"#F5E8D8",border:"none",borderRadius:12,padding:"12px",fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{isChange?"รับทราบ":"ปิด"}</button>
      </div>

      {showR&&order&&<div style={{borderRadius:12,overflow:"hidden",border:"1px solid #D4C4B0",marginBottom:4}}>
        <div ref={receiptRef} style={{background:"#fff",color:"#000",fontFamily:"'Sarabun','Noto Sans Thai',sans-serif",padding:"20px 18px",textAlign:"center",width:"100%",maxWidth:"600px",margin:"0 auto",boxSizing:"border-box"}}>

          {/* หัวบิล: โลโก้ + ชื่อร้าน */}
          {logo?<><img src={logo} alt="logo" style={{width:70,height:70,objectFit:"contain",margin:"0 auto 6px",display:"block"}}/><div style={{fontWeight:700,fontSize:16}}>{shop}</div></>:<div style={{fontWeight:700,fontSize:19,letterSpacing:"0.04em"}}>{shop}</div>}
          {staff&&<div style={{fontSize:12,color:"#444",marginTop:2}}>พนักงาน: {staff}</div>}
          {/* ที่อยู่ร้าน — ใต้ชื่อร้าน */}
          {address&&<div style={{fontSize:11,color:"#555",marginTop:3,lineHeight:1.5}}>{address}</div>}
          {/* ช่องทางติดต่อ — ใต้ที่อยู่ */}
          {contact&&<div style={{fontSize:11,color:"#555",marginTop:2}}>{contact}</div>}
          <div style={{fontSize:12,color:"#555",marginTop:4}}>ใบเสร็จรับเงิน / Receipt</div>

          <div style={{borderTop:"1px dashed #aaa",margin:"10px 0"}}/>

          <div style={{textAlign:"left",fontSize:12,color:"#333",lineHeight:1.9}}>
            <div>เลขที่บิล: <b>{order.orderNum?fmtNum(order.orderNum):`#${order.id?.slice(-4).toUpperCase()}`}</b></div>
            <div>วันที่: {fmtDate(order.date)}</div>
            <div>เวลา: {fmtTime(order.ts)}</div>
          </div>

          <div style={{borderTop:"1px dashed #aaa",margin:"10px 0"}}/>

          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,textAlign:"left",tableLayout:"fixed"}}>
            <colgroup><col style={{width:"55%"}}/><col style={{width:"15%"}}/><col style={{width:"30%"}}/></colgroup>
            <thead><tr style={{borderBottom:"1px solid #ccc"}}><th style={{padding:"3px 0",fontWeight:600}}>รายการ</th><th style={{textAlign:"center",fontWeight:600}}>จำนวน</th><th style={{textAlign:"right",fontWeight:600}}>ราคา</th></tr></thead>
            <tbody>{order.items.map((item,i)=><tr key={i}><td style={{padding:"3px 0",lineHeight:1.5,wordBreak:"break-word",paddingRight:4}}>{item.name} <span style={{color:"#666",fontSize:10}}>({item.variant})</span>{item.note&&<div style={{fontSize:9,color:"#888"}}>— {item.note}</div>}</td><td style={{textAlign:"center",whiteSpace:"nowrap"}}>{item.qty} {item.unit||""}</td><td style={{textAlign:"right",whiteSpace:"nowrap",fontWeight:600}}>฿{(item.price*item.qty).toLocaleString()}</td></tr>)}</tbody>
          </table>

          <div style={{borderTop:"1px solid #aaa",marginTop:8,paddingTop:8}}>
            <div style={{display:"flex",justifyContent:"space-between",fontWeight:700,fontSize:15}}><span>ยอดรวม</span><span>฿{order.total?.toLocaleString()}</span></div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#555",marginTop:3}}><span>วิธีชำระ</span><span style={{color:order.paymentMethod==="qr"?"#1D4ED8":"#166534",fontWeight:600}}>{order.paymentMethod==="qr"?"โอนจ่าย":"เงินสด"}</span></div>
            {order.paymentMethod!=="qr"&&<><div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#555"}}><span>รับเงิน</span><span>฿{order.received?.toLocaleString()}</span></div><div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#555"}}><span>เงินทอน</span><span>฿{(order.change||0).toLocaleString()}</span></div></>}
          </div>

          {/* PromptPay QR — แสดงเฉพาะบิลที่โอนจ่ายเท่านั้น */}
          {qrPayload&&order.paymentMethod==="qr"&&<>
            <div style={{borderTop:"1px dashed #aaa",margin:"12px 0"}}/>
            <div style={{textAlign:"center"}}>
              {accountName&&<>
                <div style={{fontSize:11,color:"#555",marginBottom:2}}>ชื่อบัญชี</div>
                <div style={{fontSize:14,fontWeight:700,color:"#000",marginBottom:8}}>{accountName}</div>
              </>}
              <QRCodeCanvas value={qrPayload} size={160} style={{display:"block",margin:"0 auto"}}/>
              <div style={{fontSize:20,fontWeight:700,color:"#000",marginTop:6}}>฿{order.total?.toLocaleString()}</div>
              <div style={{fontSize:10,color:"#777",marginTop:2}}>สแกนชำระผ่าน PromptPay</div>
            </div>
          </>}

          <div style={{borderTop:"1px dashed #aaa",margin:"10px 0"}}/>
          <div style={{fontSize:12,color:"#444"}}>{thankMsg}</div>
          <div style={{fontSize:12,color:"#555",marginTop:3}}>★ {shop} ★</div>
        </div>
        <div style={{background:"#EDE6DC",padding:"10px 14px"}}>
          <button onClick={saveJpg} disabled={saving} style={{width:"100%",background:"#2C1810",color:"#FFF",border:"none",borderRadius:10,padding:"10px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6,opacity:saving?0.7:1}}>
            <ImageDown size={14}/>{saving?"กำลังบันทึก...":"💾 บันทึกบิล (.jpg)"}
          </button>
        </div>
      </div>}
    </div>
  );
}
