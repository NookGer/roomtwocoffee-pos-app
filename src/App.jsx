import { useState, useCallback, useRef, useEffect } from "react";
import {
  Coffee, Pencil, Trash2, Plus, X, ShoppingCart, BarChart2,
  GripVertical, AlertTriangle, Camera, CalendarDays, RefreshCw,
  Ban, Receipt, ChevronDown, ChevronUp, ImageDown, BookOpen,
  Settings, RotateCcw, CheckCircle, Download, Eye, Tag,
  Wallet, ArrowDownCircle, ArrowUpCircle, Undo2, PiggyBank,
  History
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────────────────────
const SB_URL = "https://ejbggtfgmbfvaaatjmmo.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqYmdndGZnbWJmdmFhYXRqbW1vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0ODE1OTksImV4cCI6MjA5NDA1NzU5OX0.1Giv3iHq3xgwJsjGr5hlvnr1lVRu6z8xDNTIKVJie6w";

async function sbUpsert(payload) {
  try {
    await fetch(SB_URL + "/rest/v1/pos_snapshots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({ id: "main", data: payload, updated_at: new Date().toISOString() }),
    });
  } catch (e) { console.warn("Supabase upsert failed", e); }
}

async function sbFetch() {
  const res = await fetch(SB_URL + "/rest/v1/pos_snapshots?id=eq.main&select=data", {
    headers: { "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY },
  });
  if (!res.ok) throw new Error(await res.text());
  const rows = await res.json();
  return rows[0] ? rows[0].data : null;
}

// ─────────────────────────────────────────────────────────────
// STORAGE KEYS
// ─────────────────────────────────────────────────────────────
const SK_DATA = "rt8_data";
const SK_RCPT = "rt8_rcpt";
const SK_SYNC = "rt8_sync";
const SK_LDGR = "rt8_ldgr";
const SK_COST = "rt8_cost";
const SK_CTOF = "rt8_ctof";
const SK_SEQ  = "rt8_seq";

// ─────────────────────────────────────────────────────────────
// DEFAULTS
// ─────────────────────────────────────────────────────────────
const DEF_RCPT = { shopName: "RoomTwo Coffee", staffName: "", thankMsg: "ขอบคุณที่ใช้บริการ 🙏", logo: null };
const DEF_DATA = {
  categories: [{ id: "cat_gen", name: "ทั่วไป", color: "#6B4F3A", order: 0 }],
  products: [],
  addons: [],
  orders: [],
};

// ─────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────
function ls_get(key, def) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : def; } catch(e) { return def; }
}
function ls_set(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
}

// ─────────────────────────────────────────────────────────────
// DAILY ORDER NUMBER
// ─────────────────────────────────────────────────────────────
function getNextOrderNum(date) {
  const seq = ls_get(SK_SEQ, { date: "", count: 0 });
  const next = seq.date === date ? seq.count + 1 : 1;
  ls_set(SK_SEQ, { date, count: next });
  return next;
}
function peekOrderNum(date) {
  const seq = ls_get(SK_SEQ, { date: "", count: 0 });
  return seq.date === date ? seq.count + 1 : 1;
}
function fmtNum(n) { return "#" + String(n).padStart(3, "0"); }

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────
const PALETTE = [
  "#6B4F3A","#4A7C6B","#7C6B4A","#8B6B4A","#4A6B7C","#7C4A6B",
  "#6B7C4A","#7C4A4A","#4A4A7C","#C87941","#41967C","#7941C8",
  "#C84179","#4179C8","#79C841","#C8A841",
];
const MAX_ORDERS = 40000;

function todayStr() { return new Date().toISOString().split("T")[0]; }
function fmtDate(s) { return new Date(s + "T00:00:00").toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); }
function fmtDateS(s) { return new Date(s + "T00:00:00").toLocaleDateString("th-TH", { day: "numeric", month: "short" }); }
function fmtTime(s) { return new Date(s).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }); }
function fmtDT(s) { return new Date(s).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
function baht(n) { return "฿" + Number(n || 0).toLocaleString("th-TH"); }
function uid() { return Math.random().toString(36).slice(2, 9); }
function reindex(arr) { return arr.map((x, i) => ({ ...x, order: i })); }
function dateBadge(d) {
  const t = todayStr();
  if (d === t) return null;
  return d < t ? { label: "ย้อนหลัง", bg: "#C87941" } : { label: "ล่วงหน้า", bg: "#4179C8" };
}

// ─────────────────────────────────────────────────────────────
// LEDGER CASH HELPERS
// cash is now COMPUTED from ledger — no separate cash state
// ─────────────────────────────────────────────────────────────
function computeCash(ledger) {
  // Start from zero, replay all transactions in order
  let capital = 0, profit = 0;
  const sorted = [...ledger].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  sorted.forEach(e => {
    if (e.type === "initial") {
      // ตั้งค่าเงินเริ่มต้น: set absolute values
      capital = e.capital || 0;
      profit  = e.profit  || 0;
    }
    if (e.type === "category") {
      capital += (e.cost      || 0);
      profit  += (e.netProfit || 0);
    }
    if (e.type === "expense") {
      capital -= (e.amount || 0);
    }
    if (e.type === "withdrawal") {
      profit  -= (e.amount || 0);
    }
  });
  return { capital, profit, total: capital + profit };
}

// ─────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [data,     setData]    = useState(() => { const d = ls_get(SK_DATA, DEF_DATA); if (!d.addons) d.addons = []; return d; });
  const [rcpt,     setRcptSt]  = useState(() => ls_get(SK_RCPT, DEF_RCPT));
  const [ledger,   setLedger]  = useState(() => ls_get(SK_LDGR, []));
  const [costs,    setCosts]   = useState(() => ls_get(SK_COST, {}));
  const [ctof,     setCtof]    = useState(() => ls_get(SK_CTOF, {}));
  const [syncSt,   setSyncSt]  = useState(() => ({ status: navigator.onLine ? "synced" : "offline", ...ls_get(SK_SYNC, { lastSynced: null }) }));
  const [activeCat,setActive]  = useState(null);
  const [cart,     setCart]    = useState([]);
  const [modal,    setModal]   = useState(null);
  const [dispDate, setDispDate]= useState(todayStr());
  const [pendDate, setPendDate]= useState(null);
  const [view,     setView]    = useState("pos");
  const [nextNum,  setNextNum] = useState(() => peekOrderNum(todayStr()));

  // Derive cash from ledger (single source of truth)
  const cash = computeCash(ledger);

  useEffect(() => {
    const s = data.categories.slice().sort((a, b) => a.order - b.order);
    if (s.length && !s.find(c => c.id === activeCat)) setActive(s[0].id);
  }, [data.categories]);

  useEffect(() => {
    const goOn  = () => setSyncSt(s => ({ ...s, status: "synced" }));
    const goOff = () => setSyncSt(s => ({ ...s, status: "offline" }));
    window.addEventListener("online",  goOn);
    window.addEventListener("offline", goOff);
    return () => { window.removeEventListener("online", goOn); window.removeEventListener("offline", goOff); };
  }, []);

  // ── Sync to Supabase ──
  const syncUp = useCallback((d, l, cs, ct, r) => {
    if (!navigator.onLine) return;
    setSyncSt(s => ({ ...s, status: "syncing" }));
    const snap = { data: d, ledger: l.slice(-MAX_ORDERS), costs: cs, ctof: ct, rcpt: r };
    sbUpsert(snap).then(() => {
      const ts = new Date().toISOString();
      setSyncSt({ status: "synced", lastSynced: ts });
      ls_set(SK_SYNC, { lastSynced: ts });
    }).catch(() => setSyncSt(s => ({ ...s, status: "error" })));
  }, []);

  // ── Master persist ──
  const persist = useCallback((nd, nl, ncs, nct, doSync) => {
    const d  = nd  != null ? nd  : data;
    const l  = nl  != null ? nl  : ledger;
    const cs = ncs != null ? ncs : costs;
    const ct = nct != null ? nct : ctof;
    setData(d);   ls_set(SK_DATA, d);
    setLedger(l); ls_set(SK_LDGR, l);
    setCosts(cs); ls_set(SK_COST, cs);
    setCtof(ct);  ls_set(SK_CTOF, ct);
    if (doSync) syncUp(d, l, cs, ct, rcpt);
  }, [data, ledger, costs, ctof, rcpt, syncUp]);

  const persistRcpt = r => { setRcptSt(r); ls_set(SK_RCPT, r); };

  const handleRestore = async () => {
    setSyncSt(s => ({ ...s, status: "syncing" }));
    try {
      const snap = await sbFetch();
      if (snap) {
        const d  = snap.data   || DEF_DATA;
        const l  = snap.ledger || [];
        const cs = snap.costs  || {};
        const ct = snap.ctof   || {};
        setData(d);   ls_set(SK_DATA, d);
        setLedger(l); ls_set(SK_LDGR, l);
        setCosts(cs); ls_set(SK_COST, cs);
        setCtof(ct);  ls_set(SK_CTOF, ct);
        if (snap.rcpt) { setRcptSt(snap.rcpt); ls_set(SK_RCPT, snap.rcpt); }
        setModal({ type: "alert", msg: "กู้คืนข้อมูลจาก Supabase สำเร็จ ✅" });
      } else {
        setModal({ type: "alert", msg: "ไม่พบข้อมูลบน Supabase" });
      }
    } catch(e) {
      setModal({ type: "alert", msg: "เชื่อมต่อ Supabase ไม่ได้\n" + e.message });
    }
    setSyncSt(s => ({ ...s, status: navigator.onLine ? "synced" : "offline" }));
  };

  const sortedCats  = data.categories.slice().sort((a, b) => a.order - b.order);
  const catProducts = data.products.filter(p => p.categoryId === activeCat).sort((a, b) => a.order - b.order);
  const catAddons   = (data.addons || []).filter(a => a.categoryIds?.includes(activeCat));

  // ── Cart ──
  function addToCart(prod, vari, selAo = [], modSels = []) {
    const aoAmt = selAo.reduce((s, a) => s + a.price, 0);
    const total = vari.price + aoAmt;
    const aoStr = selAo.map(a => `${a.name}+${a.price}`).join(", ");
    const modStr= modSels.map(m => m.optionLabel).filter(Boolean).join(", ");
    const note  = [aoStr, modStr].filter(Boolean).join(" | ");
    const aKey  = selAo.map(a => a.id).sort().join(",");
    const mKey  = modSels.map(m => m.optionId).join(",");
    const key   = `${prod.id}|${vari.id}|${aKey}|${mKey}`;
    setCart(c => {
      const ex = c.find(i => i.key === key);
      if (ex) return c.map(i => i.key === key ? { ...i, qty: i.qty + 1 } : i);
      return [...c, { key, productId: prod.id, variantId: vari.id, name: prod.name, variant: vari.name, price: total, unit: prod.unit || "", note, selectedAddons: selAo, modifiers: modSels, qty: 1, done: false }];
    });
  }
  function cartQty(key, d) {
    setCart(c => c.map(i => i.key === key ? { ...i, qty: Math.max(0, i.qty + d) } : i).filter(i => i.qty > 0));
  }
  function cartDone(key) {
    setCart(c => c.map(i => i.key === key ? { ...i, done: !i.done } : i));
  }
  function updateCartItem(oldKey, prod, vari, selAo = [], modSels = [], oldQty) {
    const aoAmt = selAo.reduce((s, a) => s + a.price, 0);
    const total = vari.price + aoAmt;
    const aoStr = selAo.map(a => `${a.name}+${a.price}`).join(", ");
    const modStr= modSels.map(m => m.optionLabel).filter(Boolean).join(", ");
    const note  = [aoStr, modStr].filter(Boolean).join(" | ");
    const aKey  = selAo.map(a => a.id).sort().join(",");
    const mKey  = modSels.map(m => m.optionId).join(",");
    const newKey= `${prod.id}|${vari.id}|${aKey}|${mKey}`;
    const newItem = { key: newKey, productId: prod.id, variantId: vari.id, name: prod.name, variant: vari.name, price: total, unit: prod.unit || "", note, selectedAddons: selAo, modifiers: modSels, qty: oldQty, done: false };
    setCart(c => {
      const others = c.filter(i => i.key !== oldKey);
      const existing = others.find(i => i.key === newKey);
      if (existing) return others.map(i => i.key === newKey ? { ...i, qty: i.qty + oldQty } : i);
      return c.map(i => i.key === oldKey ? newItem : i);
    });
  }
  function openEditModal(item) {
    const prod = data.products.find(p => p.id === item.productId);
    if (!prod) return;
    const initVariant = prod.variants.find(v => v.id === item.variantId) || null;
    setModal({ type: "editCartItem", product: prod, oldKey: item.key, oldQty: item.qty, initialVariant: initVariant, initialAo: item.selectedAddons || [], initialMods: item.modifiers || [] });
  }
  const cartTotal = cart.reduce((s, i) => s + i.price * i.qty, 0);

  // ── Date ──
  function requestDateChange(nd) {
    if (!nd) return;
    if (nd === todayStr()) { setDispDate(nd); setNextNum(peekOrderNum(nd)); return; }
    setPendDate(nd); setModal({ type: "confirmDate", newDate: nd });
  }
  function confirmDateChange() {
    if (pendDate) { setDispDate(pendDate); setNextNum(peekOrderNum(pendDate)); setPendDate(null); }
    setModal(null);
  }

  // ── Checkout ──
  function checkout() {
    if (!cart.length) return;
    if (dispDate !== todayStr()) setModal({ type: "confirmOrderDate", date: dispDate, cartTotal });
    else setModal({ type: "payment", received: "", total: cartTotal });
  }
  function confirmPay(lastCart, lastTotal) {
    const rcv = parseInt(modal.received || "0", 10);
    if (rcv < lastTotal) return;
    const orderNum = getNextOrderNum(dispDate);
    setNextNum(peekOrderNum(dispDate));
    const order = { id: uid(), orderNum, date: dispDate, items: [...lastCart], total: lastTotal, received: rcv, change: rcv - lastTotal, ts: new Date().toISOString(), isCanceled: false };
    const newOrders = [...data.orders, order].slice(-MAX_ORDERS);
    persist({ ...data, orders: newOrders }, null, null, null, true);
    setModal({ type: "change", change: rcv - lastTotal, received: rcv, total: lastTotal, order, rcpt });
  }
  function dismissChange() { setCart([]); setNextNum(peekOrderNum(dispDate)); setModal(null); }
  function voidOrder(id) { persist({ ...data, orders: data.orders.map(o => o.id === id ? { ...o, isCanceled: true } : o) }, null, null, null, true); }
  function hardDeleteOrder(id) { persist({ ...data, orders: data.orders.filter(o => o.id !== id) }, null, null, null, true); }

  // ── Ledger entries (category sales commits) ──
  function addLedgerEntry(entry, ctofPatch) {
    const nl = [...ledger, { ...entry, id: uid(), ts: new Date().toISOString() }].slice(-MAX_ORDERS);
    const newCtof = ctofPatch ? { ...ctof, ...ctofPatch } : ctof;
    persist(null, nl, null, newCtof, true);
  }

  // ── Undo ledger entry — works for all types ──
  function undoLedgerEntry(id) {
    const entry = ledger.find(e => e.id === id);
    if (!entry) return;
    const nl = ledger.filter(e => e.id !== id);
    // restore cutoffs for category entries
    const newCtof = { ...ctof };
    if (entry.type === "category") {
      (entry.catIds || (entry.catId ? [entry.catId] : [])).forEach(cid => delete newCtof[cid]);
    }
    persist(null, nl, null, newCtof, true);
  }

  // ── Cash management — all via ledger transactions ──
  function addCashTransaction(entry) {
    // entry: { type: "initial"|"expense"|"withdrawal", ... }
    const nl = [...ledger, { ...entry, id: uid(), ts: new Date().toISOString() }].slice(-MAX_ORDERS);
    persist(null, nl, null, null, true);
  }

  // ── Clear test data ──
  function clearData() {
    const clearedLedger = ledger.filter(e => e.type === "initial"); // keep initial settings
    persist({ ...data, orders: [] }, clearedLedger, costs, {}, true);
  }

  const badge = dateBadge(dispDate);

  return (
    <div style={{ fontFamily: "'Sarabun','Noto Sans Thai',sans-serif", background: "#F5F0EA", minHeight: "100vh", display: "flex", flexDirection: "column", userSelect: "none" }}>

      {/* TOP BAR */}
      <div style={{ background: "#2C1810", padding: "8px 16px", display: "flex", alignItems: "center", gap: 9, flexShrink: 0, zIndex: 10 }}>
        <Coffee size={18} color="#D4A574" />
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.07em", color: "#D4A574" }}>RoomTwo Coffee</span>
        <SyncIndicator syncSt={syncSt} onRestore={handleRestore} />
        <div style={{ flex: 1 }} />
        <DatePill dispDate={dispDate} badge={badge} onChangeRequest={requestDateChange} />
        {badge && (
          <button onClick={() => { setDispDate(todayStr()); setNextNum(peekOrderNum(todayStr())); }}
            style={{ background: "rgba(255,255,255,.1)", border: "1px solid rgba(255,255,255,.2)", color: "#C8A882", borderRadius: 20, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
            <RotateCcw size={10} /> รีเซ็ต
          </button>
        )}
        {[["pos","🧾","POS"],["manage","⚙️","จัดการ"],["report","📊","รายงาน"],["ledger","📒","บัญชี"],["rcptset","🖨️","ตั้งค่าบิล"]].map(([k,ic,lb]) => (
          <button key={k} onClick={() => setView(k)}
            style={{ background: view === k ? "#D4A574" : "rgba(255,255,255,.09)", color: view === k ? "#2C1810" : "#C8A882", border: "none", borderRadius: 9, padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all .18s" }}>
            {ic} {lb}
          </button>
        ))}
      </div>

      {/* VIEWS */}
      {view === "pos"     && <PosView sortedCats={sortedCats} catProducts={catProducts} catAddons={catAddons} activeCat={activeCat} setActive={setActive} cart={cart} cartTotal={cartTotal} cartQty={cartQty} cartDone={cartDone} addToCart={addToCart} checkout={checkout} setCart={setCart} setModal={setModal} nextNum={nextNum} data={data} openEditModal={openEditModal} />}
      {view === "manage"  && <ManageView data={data} persist={(nd, doSync) => persist(nd, null, null, null, doSync)} onClearData={clearData} />}
      {view === "report"  && <ReportView data={data} dispDate={dispDate} onVoid={voidOrder} onHardDelete={hardDeleteOrder} rcpt={rcpt} costs={costs} setCosts={cs => persist(null, null, cs, null, true)} onLedgerCommit={addLedgerEntry} ctof={ctof} ledger={ledger} />}
      {view === "ledger"  && <LedgerView ledger={ledger} cash={cash} data={data} dispDate={dispDate} onUndoEntry={undoLedgerEntry} onAddCashTx={addCashTransaction} />}
      {view === "rcptset" && <ReceiptSettingsView settings={rcpt} onSave={persistRcpt} />}

      {/* MODALS */}
      {modal?.type === "order"            && <Overlay onClose={() => setModal(null)} wide><OrderModal product={modal.product} catAddons={(data.addons || []).filter(a => a.categoryIds?.includes(modal.product.categoryId))} onConfirm={(v, ao, mods) => { addToCart(modal.product, v, ao, mods); setModal(null); }} /></Overlay>}
      {modal?.type === "editCartItem"     && <Overlay onClose={() => setModal(null)} wide><OrderModal product={modal.product} catAddons={(data.addons || []).filter(a => a.categoryIds?.includes(modal.product.categoryId))} initialVariant={modal.initialVariant} initialAo={modal.initialAo} initialMods={modal.initialMods} isEditing onConfirm={(v, ao, mods) => { updateCartItem(modal.oldKey, modal.product, v, ao, mods, modal.oldQty); setModal(null); }} /></Overlay>}
      {modal?.type === "payment"          && <Overlay onClose={() => setModal(null)} wide><PaymentModal modal={modal} setModal={setModal} cartTotal={cartTotal} onConfirm={() => confirmPay(cart, cartTotal)} /></Overlay>}
      {modal?.type === "change"           && <Overlay onClose={dismissChange} wide><ChangeModal modal={modal} onDismiss={dismissChange} /></Overlay>}
      {modal?.type === "viewReceipt"      && <Overlay onClose={() => setModal(null)} wide><ChangeModal modal={modal} onDismiss={() => setModal(null)} /></Overlay>}
      {modal?.type === "alert"            && <Overlay onClose={() => setModal(null)}><AlertModal msg={modal.msg} onClose={() => setModal(null)} /></Overlay>}
      {modal?.type === "confirm"          && <Overlay onClose={() => setModal(null)}><ConfirmModal {...modal} onConfirm={() => { modal.onConfirm(); setModal(null); }} onCancel={() => setModal(null)} /></Overlay>}
      {modal?.type === "confirmDate"      && <Overlay onClose={() => setModal(null)}><ConfirmModal icon={<CalendarDays size={36} color="#C87941" style={{ margin: "0 auto 12px" }} />} msg={`เปลี่ยนวันที่รับออเดอร์เป็น\n"${fmtDate(modal.newDate)}"\nยืนยันหรือไม่?`} confirmLabel="ยืนยัน" confirmColor="#6B4F3A" onConfirm={confirmDateChange} onCancel={() => setModal(null)} /></Overlay>}
      {modal?.type === "confirmOrderDate" && <Overlay onClose={() => setModal(null)}><ConfirmModal icon={<AlertTriangle size={36} color="#C87941" style={{ margin: "0 auto 12px" }} />} msg={`ออเดอร์จะถูกบันทึกในวันที่\n"${fmtDate(modal.date)}"\nยืนยัน?`} confirmLabel="ยืนยัน" confirmColor="#6B4F3A" onConfirm={() => setModal({ type: "payment", received: "", total: modal.cartTotal })} onCancel={() => setModal(null)} /></Overlay>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SYNC INDICATOR
// ─────────────────────────────────────────────────────────────
function SyncIndicator({ syncSt, onRestore }) {
  const [open, setOpen] = useState(false);
  const cfg = { synced: { color: "#6CC97A", label: "Synced" }, syncing: { color: "#C8A841", label: "Syncing..." }, offline: { color: "#C96C6C", label: "Offline" }, error: { color: "#C96C6C", label: "Error" } }[syncSt.status] || { color: "#C8A882", label: "" };
  return (
    <div style={{ position: "relative" }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,.07)", borderRadius: 20, padding: "3px 10px", border: "1px solid rgba(255,255,255,.12)", cursor: "pointer" }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: cfg.color, boxShadow: `0 0 5px ${cfg.color}`, flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: cfg.color, whiteSpace: "nowrap" }}>{cfg.label}</span>
      </div>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, background: "#2C1810", border: "1px solid rgba(255,255,255,.15)", borderRadius: 12, padding: "12px 14px", minWidth: 240, zIndex: 999, boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
          <div style={{ fontSize: 12, color: "#C8A882", marginBottom: 10, lineHeight: 1.6 }}>{syncSt.lastSynced ? `ซิงก์ล่าสุด:\n${fmtDT(syncSt.lastSynced)}` : "ยังไม่เคยซิงก์"}</div>
          <button onClick={() => { setOpen(false); onRestore(); }} style={{ width: "100%", background: "rgba(255,255,255,.1)", color: "#F5E8D8", border: "1px solid rgba(255,255,255,.2)", borderRadius: 8, padding: "7px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Download size={12} /> ดึงข้อมูลจาก Supabase
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// DATE PILL
// ─────────────────────────────────────────────────────────────
function DatePill({ dispDate, badge, onChangeRequest }) {
  const [editing, setEditing] = useState(false);
  if (editing) return (
    <input type="date" defaultValue={dispDate} autoFocus
      style={{ background: "rgba(255,255,255,.14)", border: "1px solid rgba(255,255,255,.35)", color: "#F5E8D8", borderRadius: 20, padding: "4px 12px", fontSize: 12, fontFamily: "inherit", outline: "none", colorScheme: "dark" }}
      onChange={e => { if (e.target.value) { onChangeRequest(e.target.value); setEditing(false); } }}
      onBlur={() => setEditing(false)} />
  );
  return (
    <button onClick={() => setEditing(true)} style={{ background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.18)", color: "#C8A882", borderRadius: 20, padding: "5px 12px", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, fontFamily: "inherit" }}>
      <CalendarDays size={12} />{fmtDate(dispDate)}
      {badge && <span style={{ background: badge.bg, borderRadius: 10, padding: "0 6px", fontSize: 10, color: "#FFF", marginLeft: 2 }}>{badge.label}</span>}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// POS VIEW
// ─────────────────────────────────────────────────────────────
function PosView({ sortedCats, catProducts, catAddons, activeCat, setActive, cart, cartTotal, cartQty, cartDone, addToCart, checkout, setCart, setModal, nextNum, data, openEditModal }) {
  const unitLabel = cart.length === 0 ? "" : (() => {
    const u = {};
    cart.forEach(i => { const k = i.unit || "รายการ"; u[k] = (u[k] || 0) + i.qty; });
    return Object.keys(u).map(k => `${u[k]} ${k}`).join(", ");
  })();

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", height: "calc(100vh - 50px)" }}>
      {/* Categories */}
      <div style={{ width: 124, background: "#EDE6DC", borderRight: "1px solid #D4C4B0", overflowY: "auto", padding: "10px 7px", display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
        {sortedCats.map(cat => (
          <button key={cat.id} onClick={() => setActive(cat.id)} className="cat-btn"
            style={{ background: activeCat === cat.id ? cat.color : "transparent", color: activeCat === cat.id ? "#FFF" : "#5C4A36", border: `1.5px solid ${activeCat === cat.id ? cat.color : "#C4B4A0"}`, borderRadius: 10, padding: "10px 6px", fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "center" }}>
            {cat.name}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => setModal({ type: "alert", msg: "ไปที่ 'จัดการ' เพื่อเพิ่มหมวดหมู่" })}
          style={{ background: "none", border: "1.5px dashed #C4B4A0", borderRadius: 10, padding: 8, fontSize: 12, color: "#9C8C7C", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
          <Plus size={12} /> หมวดหมู่
        </button>
      </div>

      {/* Products */}
      <div style={{ flex: 1, overflowY: "auto", padding: 14, background: "#F5F0EA" }}>
        {catProducts.length === 0 ? (
          <div style={{ textAlign: "center", color: "#9C8C7C", marginTop: 60, fontSize: 14 }}>
            <Coffee size={34} style={{ margin: "0 auto 12px", opacity: .35 }} /><br />ยังไม่มีสินค้า
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(134px,1fr))", gap: 12 }}>
            {catProducts.map(p => (
              <div key={p.id} className="prod-card" onClick={() => setModal({ type: "order", product: p })}
                style={{ background: p.color, borderRadius: 14, minHeight: 114, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 12, gap: 6, cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,.07)" }}>
                {p.image ? <img src={p.image} alt={p.name} style={{ width: 52, height: 52, borderRadius: 10, objectFit: "cover" }} />
                         : <span style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,.93)", textAlign: "center", lineHeight: 1.4 }}>{p.name}</span>}
                <span style={{ fontSize: 11, color: "rgba(255,255,255,.72)" }}>
                  {p.variants.length === 1 ? `฿${p.variants[0].price}` : `฿${Math.min(...p.variants.map(v => v.price))}+`}
                </span>
                {(catAddons?.length > 0 || p.modifierGroups?.length > 0) && <span style={{ fontSize: 9, color: "rgba(255,255,255,.55)" }}>+ ตัวเลือกเสริม</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cart */}
      <div style={{ width: 294, background: "#FFF8F2", borderLeft: "1px solid #E4D4C0", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "11px 14px", borderBottom: "1px solid #E4D4C0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ShoppingCart size={15} color="#6B4F3A" />
            <span style={{ fontWeight: 700, fontSize: 14, color: "#2C1810" }}>ออเดอร์</span>
            <span style={{ background: "#EDE6DC", color: "#6B4F3A", borderRadius: 10, padding: "1px 9px", fontSize: 12, fontWeight: 700 }}>{fmtNum(nextNum)}</span>
          </div>
          {cart.length > 0 && <button onClick={() => setCart([])} style={{ background: "none", border: "none", color: "#C88C6C", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>ล้างทั้งหมด</button>}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px" }}>
          {cart.length === 0
            ? <div style={{ textAlign: "center", color: "#B8A898", marginTop: 40, fontSize: 13 }}><ShoppingCart size={30} style={{ margin: "0 auto 8px", opacity: .4 }} /><br />ยังไม่มีรายการ</div>
            : cart.map(item => <CartItem key={item.key} item={item} onQty={cartQty} onDone={cartDone} onEdit={openEditModal} />)}
        </div>
        {/* checkout bar with safe-area padding for iPad */}
        <div className="checkout-bar" style={{ padding: "12px 14px", borderTop: "1px solid #E4D4C0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ color: "#5C4A36", fontSize: 12 }}>{unitLabel || "ยังไม่มีรายการ"}</span>
            <span style={{ fontWeight: 700, fontSize: 20, color: "#2C1810" }}>{baht(cartTotal)}</span>
          </div>
          <button onClick={checkout} className="checkout-btn"
            style={{ width: "100%", background: cart.length ? "#2C1810" : "#B0A098", color: "#F5E8D8", border: "none", borderRadius: 12, padding: "13px", fontSize: 16, fontWeight: 700, cursor: cart.length ? "pointer" : "not-allowed" }}>
            💳 จ่ายเงิน
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ORDER MODAL
// ─────────────────────────────────────────────────────────────
function OrderModal({ product, catAddons, onConfirm, isEditing, initialVariant, initialAo = [], initialMods = [] }) {
  const [selV,   setSelV]  = useState(() => initialVariant || (product.variants.length === 1 ? product.variants[0] : null));
  const [selAo,  setSelAo] = useState(() => [...initialAo]);
  const [modSel, setModSel]= useState(() => {
    const obj = {};
    initialMods.forEach(m => { if (m?.groupId) obj[m.groupId] = m; });
    return obj;
  });
  const groups = product.modifierGroups || [];

  const toggleAo  = ao => setSelAo(prev => prev.find(a => a.id === ao.id) ? prev.filter(a => a.id !== ao.id) : [...prev, ao]);
  const toggleMod = (g, o) => setModSel(prev => {
    if (prev[g.id]?.optionId === o.id) { const n = { ...prev }; delete n[g.id]; return n; }
    return { ...prev, [g.id]: { groupId: g.id, groupName: g.name, optionId: o.id, optionLabel: o.label } };
  });

  const aoAmt = selAo.reduce((s, a) => s + a.price, 0);
  const totalPrice = (selV?.price || 0) + aoAmt;
  const canConfirm = !!selV;

  return (
    <div>
      {isEditing && (
        <div style={{ background: "#EDE6DC", borderRadius: 9, padding: "6px 12px", marginBottom: 12, fontSize: 12, color: "#6B4F3A", display: "flex", alignItems: "center", gap: 5 }}>
          ✎ โหมดแก้ไขรายการ — เลือกรายละเอียดใหม่แล้วกดยืนยัน
        </div>
      )}
      <div style={{ fontWeight: 700, fontSize: 17, color: "#2C1810", marginBottom: 4, textAlign: "center" }}>{product.name}</div>
      {product.unit && <div style={{ fontSize: 12, color: "#8C7C6C", textAlign: "center", marginBottom: 14 }}>หน่วย: {product.unit}</div>}

      <SecLabel>รูปแบบ <span style={{ color: "#C84B4B" }}>*</span></SecLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {product.variants.map(v => (
          <button key={v.id} onClick={() => setSelV(v)}
            style={{ background: selV?.id === v.id ? product.color : "#F5F0EA", color: selV?.id === v.id ? "#FFF" : "#2C1810", border: `2px solid ${selV?.id === v.id ? product.color : "#D4C4B0"}`, borderRadius: 11, padding: "11px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", justifyContent: "space-between", fontFamily: "inherit", transition: "all .15s" }}>
            <span>{v.name}</span><span>฿{v.price}</span>
          </button>
        ))}
      </div>

      {catAddons?.length > 0 && (
        <>
          <SecLabel>Add-on (คิดเงิน)</SecLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginBottom: 16 }}>
            {catAddons.map(ao => {
              const act = selAo.find(a => a.id === ao.id);
              return (
                <button key={ao.id} onClick={() => toggleAo(ao)}
                  style={{ background: act ? "#2C1810" : "#F0E8DC", color: act ? "#FFF" : "#5C4A36", border: `1.5px solid ${act ? "#2C1810" : "#D4C4B0"}`, borderRadius: 9, padding: "8px 4px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", textAlign: "center", lineHeight: 1.4 }}>
                  {act ? "✓ " : ""}{ao.name}<br /><span style={{ fontSize: 10, opacity: .8 }}>+฿{ao.price}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {groups.map(g => (
        <div key={g.id} style={{ marginBottom: 14 }}>
          <SecLabel>{g.name}</SecLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
            {g.options.map(o => {
              const act = modSel[g.id]?.optionId === o.id;
              return (
                <button key={o.id} onClick={() => toggleMod(g, o)}
                  style={{ background: act ? "#6B4F3A" : "#F0E8DC", color: act ? "#FFF" : "#5C4A36", border: `1.5px solid ${act ? "#6B4F3A" : "#D4C4B0"}`, borderRadius: 9, padding: "8px 4px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", textAlign: "center" }}>
                  {act ? "✓ " : ""}{o.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {selV && (
        <div style={{ background: "#EDE6DC", borderRadius: 10, padding: "8px 12px", marginBottom: 14, fontSize: 13, color: "#5C4A36" }}>
          <span style={{ fontWeight: 600 }}>{product.name} ({selV.name})</span>
          {selAo.length > 0 && <span style={{ color: "#7941C8" }}> + {selAo.map(a => a.name).join(", ")}</span>}
          {Object.values(modSel).length > 0 && <span style={{ color: "#6B4F3A" }}> — {Object.values(modSel).map(m => m.optionLabel).join(", ")}</span>}
          <span style={{ float: "right", fontWeight: 700, color: "#2C1810" }}>฿{totalPrice}</span>
        </div>
      )}

      <button onClick={() => canConfirm && onConfirm(selV, selAo, Object.values(modSel))} disabled={!canConfirm}
        style={{ width: "100%", background: canConfirm ? product.color : "#C0B0A0", color: "#FFF", border: "none", borderRadius: 12, padding: "14px", fontSize: 16, fontWeight: 700, cursor: canConfirm ? "pointer" : "not-allowed", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <CheckCircle size={18} /> {isEditing ? "✅ ยืนยันการแก้ไข" : "ยืนยันเพิ่มลงตะกร้า"}{canConfirm ? ` — ${baht(totalPrice)}` : ""}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MANAGE VIEW
// ─────────────────────────────────────────────────────────────
function ManageView({ data, persist, onClearData }) {
  const [tab, setTab]       = useState("cats");
  const [filterCat, setFlt] = useState(null);
  const [im, setIM]         = useState(null);
  const sortedCats = data.categories.slice().sort((a, b) => a.order - b.order);
  const addons = data.addons || [];

  useEffect(() => { if (tab === "prods" && !filterCat && sortedCats.length > 0) setFlt(sortedCats[0].id); }, [tab]);

  const catProds = filterCat ? data.products.filter(p => p.categoryId === filterCat).sort((a, b) => a.order - b.order) : [];
  const drag = useRef({ item: null, over: null });

  const catDrop = () => {
    const { item, over } = drag.current;
    if (!item || item === over) return;
    const arr = [...sortedCats]; const fi = arr.findIndex(x => x.id === item); const ti = arr.findIndex(x => x.id === over);
    const [m] = arr.splice(fi, 1); arr.splice(ti, 0, m);
    persist({ ...data, categories: reindex(arr) }, true);
    drag.current = { item: null, over: null };
  };
  const prodDrop = () => {
    const { item, over } = drag.current;
    if (!item || item === over) return;
    const fi = catProds.findIndex(x => x.id === item); const ti = catProds.findIndex(x => x.id === over);
    if (fi < 0 || ti < 0) return;
    const arr = [...catProds]; const [m] = arr.splice(fi, 1); arr.splice(ti, 0, m);
    persist({ ...data, products: [...data.products.filter(p => p.categoryId !== filterCat), ...reindex(arr)] }, true);
    drag.current = { item: null, over: null };
  };

  const catDel  = id => setIM({ type: "confirm", icon: <Trash2 size={36} color="#C84B4B" style={{ margin: "0 auto 12px" }} />, msg: "ลบหมวดหมู่นี้? สินค้าในหมวดหมู่จะถูกลบด้วย", confirmLabel: "ลบเลย", confirmColor: "#C84B4B", onConfirm: () => { persist({ ...data, categories: data.categories.filter(c => c.id !== id), products: data.products.filter(p => p.categoryId !== id) }, true); if (filterCat === id) setFlt(null); } });
  const prodDel = id => setIM({ type: "confirm", icon: <Trash2 size={36} color="#C84B4B" style={{ margin: "0 auto 12px" }} />, msg: "ลบสินค้านี้?", confirmLabel: "ลบเลย", confirmColor: "#C84B4B", onConfirm: () => persist({ ...data, products: data.products.filter(p => p.id !== id) }, true) });
  const aoDel   = id => setIM({ type: "confirm", icon: <Trash2 size={36} color="#C84B4B" style={{ margin: "0 auto 12px" }} />, msg: "ลบ Add-on?", confirmLabel: "ลบเลย", confirmColor: "#C84B4B", onConfirm: () => persist({ ...data, addons: addons.filter(a => a.id !== id) }, true) });

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        {[["cats","📂 หมวดหมู่"],["prods","☕ สินค้า"],["addons","🏷️ Add-on"]].map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ background: tab===k?"#2C1810":"#F0E8DC", color: tab===k?"#FFF":"#5C4A36", border: "none", borderRadius: 10, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
        ))}
        <div style={{ flex: 1 }} />
        {tab !== "addons" && <button onClick={() => setIM(tab==="cats" ? { type:"addCat" } : { type:"addProd", catId: filterCat || data.categories[0]?.id })} style={{ background:"#2C1810", color:"#FFF", border:"none", borderRadius:10, padding:"9px 16px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:5 }}><Plus size={13} />{tab==="cats"?"เพิ่มหมวดหมู่":"เพิ่มสินค้า"}</button>}
        {tab === "addons" && <button onClick={() => setIM({ type:"addAddon" })} style={{ background:"#7941C8", color:"#FFF", border:"none", borderRadius:10, padding:"9px 16px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:5 }}><Plus size={13} /> เพิ่ม Add-on</button>}
      </div>

      {(tab==="cats"||tab==="prods") && <div style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:"#9C8C7C", marginBottom:14, background:"#EDE6DC", borderRadius:8, padding:"5px 11px", width:"fit-content" }}><GripVertical size={12} /> ลากเพื่อจัดลำดับ</div>}

      {tab === "cats" && (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {sortedCats.length===0 && <EmptyMsg label="ยังไม่มีหมวดหมู่" />}
          {sortedCats.map(cat => (
            <div key={cat.id} draggable onDragStart={() => drag.current.item=cat.id} onDragEnter={() => drag.current.over=cat.id} onDragEnd={catDrop} onDragOver={e => e.preventDefault()} className="dnd-row"
              style={{ display:"flex", alignItems:"center", gap:10, background:"#FFF8F2", border:"1px solid #E8D8C8", borderRadius:13, padding:"11px 14px", cursor:"grab" }}>
              <GripVertical size={16} color="#C4B4A0" />
              <div style={{ width:18, height:18, borderRadius:5, background:cat.color, flexShrink:0 }} />
              <span style={{ flex:1, fontWeight:600, fontSize:14, color:"#2C1810" }}>{cat.name}</span>
              <span style={{ fontSize:12, color:"#9C8C7C" }}>{data.products.filter(p=>p.categoryId===cat.id).length} สินค้า</span>
              <IconBtn variant="edit" onClick={e => { e.stopPropagation(); setIM({ type:"editCat", cat }); }}><Pencil size={13} /></IconBtn>
              <IconBtn variant="del"  onClick={e => { e.stopPropagation(); catDel(cat.id); }}><Trash2 size={13} /></IconBtn>
            </div>
          ))}
        </div>
      )}

      {tab === "prods" && (
        <>
          <div style={{ display:"flex", gap:7, flexWrap:"wrap", marginBottom:16 }}>
            {sortedCats.map(c => <ChipBtn key={c.id} active={filterCat===c.id} onClick={() => setFlt(c.id)} color={c.color}>{c.name}</ChipBtn>)}
          </div>
          {!filterCat ? <EmptyMsg label="เลือกหมวดหมู่เพื่อดูสินค้า" /> : catProds.length===0 ? <EmptyMsg label="ยังไม่มีสินค้าในหมวดนี้" /> : (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {catProds.map(p => {
                const cat = data.categories.find(c => c.id===p.categoryId);
                return (
                  <div key={p.id} draggable onDragStart={() => drag.current.item=p.id} onDragEnter={() => drag.current.over=p.id} onDragEnd={prodDrop} onDragOver={e => e.preventDefault()} className="dnd-row"
                    style={{ display:"flex", alignItems:"center", gap:10, background:"#FFF8F2", border:"1px solid #E8D8C8", borderRadius:13, padding:"10px 14px", cursor:"grab" }}>
                    <GripVertical size={16} color="#C4B4A0" />
                    <div style={{ width:38, height:38, borderRadius:9, background:p.color, flexShrink:0, overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      {p.image ? <img src={p.image} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} /> : <span style={{ fontSize:9, color:"rgba(255,255,255,.9)", fontWeight:700, textAlign:"center", padding:2 }}>{p.name.slice(0,5)}</span>}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:600, color:"#2C1810" }}>{p.name}{p.unit && <span style={{ fontSize:11, color:"#8C7C6C", fontWeight:400 }}> ({p.unit})</span>}</div>
                      <div style={{ fontSize:11, color:"#8C7C6C", display:"flex", gap:6, flexWrap:"wrap", marginTop:2, alignItems:"center" }}>
                        {cat && <span style={{ background:cat.color, color:"#FFF", borderRadius:10, padding:"1px 8px", fontSize:10 }}>{cat.name}</span>}
                        {p.variants.map(v => <span key={v.id}>{v.name} ฿{v.price}</span>)}
                        {p.modifierGroups?.length > 0 && <span style={{ color:"#7941C8", fontSize:10 }}>+{p.modifierGroups.length} ตัวเลือก</span>}
                      </div>
                    </div>
                    <IconBtn variant="edit" onClick={e => { e.stopPropagation(); setIM({ type:"editProd", prod:p }); }}><Pencil size={13} /></IconBtn>
                    <IconBtn variant="del"  onClick={e => { e.stopPropagation(); prodDel(p.id); }}><Trash2 size={13} /></IconBtn>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "addons" && (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {addons.length===0 && <EmptyMsg label="ยังไม่มี Add-on" />}
          {addons.map(ao => (
            <div key={ao.id} style={{ display:"flex", alignItems:"center", gap:10, background:"#FFF8F2", border:"1px solid #E8D8C8", borderRadius:13, padding:"11px 14px" }}>
              <Tag size={18} color="#7941C8" style={{ flexShrink:0 }} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:600, color:"#2C1810" }}>{ao.name} <span style={{ color:"#7941C8", fontWeight:700 }}>+฿{ao.price}</span></div>
                <div style={{ fontSize:11, color:"#8C7C6C", marginTop:3, display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
                  <span>แสดงใน:</span>
                  {!(ao.categoryIds?.length) ? <span style={{ color:"#C84B4B" }}>ไม่ได้เลือก</span>
                    : ao.categoryIds.map(cid => { const c=data.categories.find(x=>x.id===cid); return c?<span key={cid} style={{ background:c.color, color:"#FFF", borderRadius:10, padding:"1px 8px", fontSize:10 }}>{c.name}</span>:null; })}
                </div>
              </div>
              <IconBtn variant="edit" onClick={() => setIM({ type:"editAddon", addon:ao })}><Pencil size={13} /></IconBtn>
              <IconBtn variant="del"  onClick={() => aoDel(ao.id)}><Trash2 size={13} /></IconBtn>
            </div>
          ))}
        </div>
      )}

      {/* Reset Data */}
      <div style={{ marginTop:32, paddingTop:24, borderTop:"1px solid #E4D4C0" }}>
        <div style={{ fontSize:13, color:"#9C8C7C", marginBottom:10 }}>⚠️ โซนอันตราย — ล้างข้อมูลทดสอบก่อนเริ่มขายจริง</div>
        <button onClick={() => setIM({ type:"confirm", icon:<AlertTriangle size={36} color="#C84B4B" style={{ margin:"0 auto 12px" }} />, msg:"ล้างประวัติการขายทั้งหมด?\n\nจะล้าง: orders, ledger (ยกเว้นตั้งค่าเริ่มต้น), cutoffs\nสินค้าและหมวดหมู่ยังคงอยู่ครบ", confirmLabel:"ล้างข้อมูล", confirmColor:"#C84B4B", onConfirm: onClearData })}
          style={{ background:"#C84B4B", color:"#FFF", border:"none", borderRadius:10, padding:"12px 24px", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:7 }}>
          <Trash2 size={15} /> ล้างประวัติการขาย (Reset Data)
        </button>
      </div>

      {im?.type==="confirm"   && <Overlay onClose={() => setIM(null)}><ConfirmModal {...im} onConfirm={() => { im.onConfirm(); setIM(null); }} onCancel={() => setIM(null)} /></Overlay>}
      {im?.type==="addCat"    && <Overlay onClose={() => setIM(null)}><AddCatModal    data={data} persist={persist} onClose={() => setIM(null)} /></Overlay>}
      {im?.type==="editCat"   && <Overlay onClose={() => setIM(null)}><EditCatModal   cat={im.cat} data={data} persist={persist} onClose={() => setIM(null)} /></Overlay>}
      {im?.type==="addProd"   && <Overlay onClose={() => setIM(null)} wide><AddProdModal  data={data} persist={persist} catId={im.catId} onClose={() => setIM(null)} /></Overlay>}
      {im?.type==="editProd"  && <Overlay onClose={() => setIM(null)} wide><EditProdModal prod={im.prod} data={data} persist={persist} onClose={() => setIM(null)} /></Overlay>}
      {im?.type==="addAddon"  && <Overlay onClose={() => setIM(null)}><AddonFormModal data={data} persist={persist} onClose={() => setIM(null)} /></Overlay>}
      {im?.type==="editAddon" && <Overlay onClose={() => setIM(null)}><AddonFormModal addon={im.addon} data={data} persist={persist} onClose={() => setIM(null)} /></Overlay>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// REPORT VIEW
// ─────────────────────────────────────────────────────────────
function ReportView({ data, dispDate, onVoid, onHardDelete, rcpt, costs, setCosts, onLedgerCommit, ctof, ledger }) {
  const [from, setFrom]             = useState(dispDate);
  const [to,   setTo]               = useState(dispDate);
  const [selCats, setSelCats]       = useState([]);
  const [histOpen, setHist]         = useState(false);
  const [confModal, setConf]        = useState(null);
  const [commitConfirm, setCommitConfirm] = useState(null);
  const [consolidatedCost, setConsol] = useState("");
  const sortedCats = data.categories.slice().sort((a, b) => a.order - b.order);
  const today = todayStr();

  // Daily dashboard: revenue = all today; cost/profit = locked ledger only
  const todayAllOrders = data.orders.filter(o => o.date === today && !o.isCanceled);
  let dashRev = 0;
  todayAllOrders.forEach(o => o.items.forEach(i => { dashRev += i.price * i.qty; }));
  const todayLedger = ledger.filter(e => e.type === "category" && e.ts?.startsWith(today));
  const locked = todayLedger.reduce((acc, e) => { acc.cost += (e.cost||0); acc.profit += (e.netProfit||0); return acc; }, { cost:0, profit:0 });
  const dash = { rev: dashRev, cost: locked.cost, profit: locked.profit };

  // Pending info badge
  const pendingOrders = data.orders.filter(o => o.date === today && !o.isCanceled);
  let pendRev = 0, pendUnits = 0;
  pendingOrders.forEach(o => o.items.forEach(item => {
    const p = data.products.find(x => x.id === item.productId);
    if (!p) return;
    const co = ctof[p.categoryId] || null;
    if (co && new Date(o.ts) <= new Date(co)) return;
    pendRev   += item.price * item.qty;
    pendUnits += item.qty;
  }));

  const activeOrders = data.orders.filter(o => o.date >= from && o.date <= to && !o.isCanceled);

  // catStats with cutoffs
  const catStats = {};
  sortedCats.forEach(cat => {
    const cutoff = ctof[cat.id] || null;
    const catOrders = activeOrders.filter(o => !cutoff || new Date(o.ts) > new Date(cutoff));
    let rev = 0, units = 0, unitName = "รายการ";
    catOrders.forEach(o => o.items.forEach(item => {
      const p = data.products.find(x => x.id === item.productId);
      if (!p || p.categoryId !== cat.id) return;
      rev += item.price * item.qty; units += item.qty; if (p.unit) unitName = p.unit;
    }));
    catStats[cat.id] = { cat, rev, units, unitName };
  });

  const allChecked = selCats.length === 0 || selCats.length === sortedCats.length;
  const checkedIds = selCats.length === 0 ? sortedCats.map(c => c.id) : selCats;
  const selList    = Object.values(catStats).filter(s => checkedIds.includes(s.cat.id));
  const selRev     = selList.reduce((a, s) => a + s.rev, 0);
  const selUnits   = selList.reduce((a, s) => a + s.units, 0);
  const selUnitName= selList.length === 1 ? selList[0].unitName : "รายการ";
  const costPerUnit= parseFloat(consolidatedCost) || 0;
  const parsedCost = costPerUnit * selUnits;
  const selProfit  = selRev - parsedCost;

  const toggleCat = id => setSelCats(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  function handleCommitClick() {
    const toCommit = selList.filter(s => s.rev > 0);
    if (!toCommit.length || selRev === 0) return;
    setCommitConfirm({ items: toCommit, totalRev: selRev, totalCost: parsedCost, totalProfit: selProfit, totalUnits: selUnits, unitName: selUnitName });
  }
  function handleCommitConfirm() {
    if (!commitConfirm) return;
    const ts     = new Date().toISOString();
    const catIds = commitConfirm.items.map(s => s.cat.id);
    const entry  = { type:"category", catIds, catName: commitConfirm.items.map(s=>s.cat.name).join(", "), date:dispDate, units:commitConfirm.totalUnits, unitName:commitConfirm.unitName||"รายการ", revenue:commitConfirm.totalRev, cost:commitConfirm.totalCost, netProfit:commitConfirm.totalProfit };
    const ctofPatch = {};
    catIds.forEach(id => { ctofPatch[id] = ts; });
    onLedgerCommit(entry, ctofPatch);
    setCommitConfirm(null);
    setConsol("");
  }

  const allOrders = data.orders.filter(o => o.date >= from && o.date <= to);

  return (
    <div style={{ flex:1, overflowY:"auto", padding:"20px 24px" }}>
      <div style={{ fontWeight:700, fontSize:19, color:"#2C1810", marginBottom:16, display:"flex", alignItems:"center", gap:8 }}><BarChart2 size={19} /> รายงานยอดขาย</div>

      {/* Daily Dashboard */}
      <div style={{ background:"#2C1810", borderRadius:14, padding:"16px 18px", marginBottom:20 }}>
        <div style={{ fontSize:12, color:"#C8A882", marginBottom:10, fontWeight:600, display:"flex", justifyContent:"space-between" }}>
          <span>📊 ผลงานวันนี้ — {fmtDate(today)}</span>
          <span style={{ fontSize:10, color:"rgba(255,255,255,.4)" }}>ทุน/กำไร = เฉพาะที่บันทึกบัญชีแล้ว</span>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:pendRev>0?10:0 }}>
          {[["ยอดขายรวม",baht(dash.rev),"#D4A574"],["เงินทุน (บันทึกแล้ว)",baht(dash.cost),"#C87941"],["กำไร (บันทึกแล้ว)",baht(dash.profit),dash.profit>=0?"#6CC97A":"#C96C6C"]].map(([l,v,c]) => (
            <div key={l} style={{ background:"rgba(255,255,255,.07)", borderRadius:10, padding:"12px", textAlign:"center" }}>
              <div style={{ fontSize:11, color:"rgba(255,255,255,.6)", marginBottom:4 }}>{l}</div>
              <div style={{ fontSize:20, fontWeight:700, color:c }}>{v}</div>
            </div>
          ))}
        </div>
        {pendRev > 0 && (
          <div style={{ background:"rgba(255,255,255,.06)", borderRadius:9, padding:"7px 12px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontSize:10, color:"rgba(255,255,255,.5)" }}>⏳ รอบันทึกบัญชี ({pendUnits} รายการ)</span>
            <span style={{ fontSize:14, fontWeight:700, color:"#C8A882" }}>{baht(pendRev)}</span>
          </div>
        )}
      </div>

      {/* Calculation Area */}
      <div style={{ background:"#FFF8F2", border:"1px solid #E8D8C8", borderRadius:13, padding:18, marginBottom:18 }}>
        <div style={{ fontWeight:700, fontSize:14, color:"#2C1810", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
          <span>💰 พื้นที่คำนวณกำไร</span>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
            {[["จาก",from,setFrom],["ถึง",to,setTo]].map(([l,v,s]) => (
              <label key={l} style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:"#5C4A36" }}>
                {l}<input type="date" value={v} onChange={e => s(e.target.value)} style={{ padding:"3px 8px", borderRadius:7, border:"1px solid #D4C4B0", background:"#F5F0EA", color:"#2C1810", fontSize:12 }} />
              </label>
            ))}
            <button onClick={() => { setFrom(dispDate); setTo(dispDate); }} style={{ background:"#EDE6DC", border:"none", borderRadius:7, padding:"3px 10px", fontSize:12, color:"#5C4A36", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:4 }}><RefreshCw size={10} /> วันนี้</button>
          </div>
        </div>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, color:"#8C7C6C", marginBottom:8, fontWeight:500 }}>เลือกหมวดหมู่:</div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
            <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:13, cursor:"pointer", fontWeight:600, color:"#2C1810" }}>
              <input type="checkbox" checked={allChecked} onChange={() => setSelCats([])} style={{ accentColor:"#2C1810", width:16, height:16 }} />ทั้งหมด
            </label>
            {sortedCats.map(cat => {
              const checked = selCats.length===0 || selCats.includes(cat.id);
              const s = catStats[cat.id];
              return (
                <label key={cat.id} style={{ display:"flex", alignItems:"center", gap:5, fontSize:13, cursor:"pointer" }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleCat(cat.id)} style={{ accentColor:cat.color, width:15, height:15 }} />
                  <span style={{ background:cat.color, color:"#FFF", borderRadius:10, padding:"2px 10px", fontSize:12, fontWeight:600 }}>{cat.name}</span>
                  {s?.rev > 0 && <span style={{ fontSize:11, color:"#8C7C6C" }}>{baht(s.rev)}</span>}
                  {ctof[cat.id] && <span style={{ fontSize:10, color:"#B0A898" }}>📌{fmtDT(ctof[cat.id])}</span>}
                </label>
              );
            })}
          </div>
        </div>
        <div style={{ background:"#F5F0EA", borderRadius:10, padding:"10px 14px", marginBottom:12, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:13, color:"#2C1810", fontWeight:600 }}>รวม {selUnits} {selUnitName} — ยอดขาย {baht(selRev)}</span>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginLeft:"auto" }}>
            <span style={{ fontSize:13, color:"#5C4A36" }}>ต้นทุน/หน่วย (฿)</span>
            <input type="number" value={consolidatedCost} onChange={e => setConsol(e.target.value)} placeholder="0"
              style={{ width:90, padding:"5px 10px", borderRadius:8, border:"1px solid #D4C4B0", background:"#FFF", color:"#2C1810", fontSize:14, fontFamily:"inherit" }} />
            <span style={{ fontSize:12, color:"#8C7C6C" }}>× {selUnits} = {baht(parsedCost)}</span>
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:14 }}>
          {[["ยอดขาย",baht(selRev),"#D4A574"],["เงินทุน",baht(parsedCost),"#C87941"],["กำไร",baht(selProfit),selProfit>=0?"#3A7A3A":"#C84B4B"]].map(([l,v,c]) => (
            <div key={l} style={{ background:"#F5F0EA", borderRadius:11, padding:"12px", textAlign:"center" }}>
              <div style={{ fontSize:11, color:"#8C7C6C", marginBottom:4 }}>{l}</div>
              <div style={{ fontSize:20, fontWeight:700, color:c }}>{v}</div>
            </div>
          ))}
        </div>
        <button onClick={handleCommitClick} disabled={selRev===0}
          style={{ width:"100%", background:selRev>0?"#2C1810":"#C0B0A0", color:"#FFF", border:"none", borderRadius:10, padding:"12px", fontSize:14, fontWeight:700, cursor:selRev>0?"pointer":"not-allowed", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:7 }}>
          <BookOpen size={15} /> บันทึกลงบัญชี (รีเซ็ตยอดที่เลือก)
        </button>
      </div>

      {/* Bar chart - independent from checkbox */}
      {(() => {
        const rawList = sortedCats.map(cat => {
          let rev = 0, units = 0, unitName = "รายการ";
          activeOrders.forEach(o => o.items.forEach(item => {
            const p = data.products.find(x => x.id===item.productId);
            if (!p || p.categoryId!==cat.id) return;
            rev += item.price*item.qty; units += item.qty; if(p.unit) unitName=p.unit;
          }));
          return { cat, rev, units, unitName };
        }).filter(s => s.rev > 0).sort((a,b) => b.rev-a.rev);
        const rawTotal = rawList.reduce((a,s) => a+s.rev, 0);
        if (!rawList.length) return null;
        return (
          <div style={{ background:"#FFF8F2", border:"1px solid #E8D8C8", borderRadius:13, padding:18, marginBottom:18 }}>
            <div style={{ fontWeight:700, fontSize:14, color:"#2C1810", marginBottom:12 }}>ยอดขายตามหมวดหมู่</div>
            {rawList.map(s => (
              <div key={s.cat.id} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                <div style={{ width:11, height:11, borderRadius:3, background:s.cat.color, flexShrink:0 }} />
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:3 }}><span style={{ fontWeight:600, color:"#2C1810" }}>{s.cat.name}</span><span style={{ color:"#6B4F3A", fontWeight:700 }}>{baht(s.rev)}</span></div>
                  <div style={{ background:"#EDE6DC", borderRadius:4, height:5 }}><div style={{ background:s.cat.color, height:"100%", width:`${rawTotal>0?(s.rev/rawTotal*100):0}%`, borderRadius:4 }} /></div>
                </div>
                <span style={{ fontSize:12, color:"#8C7C6C", minWidth:56, textAlign:"right" }}>{s.units} {s.unitName}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Order History */}
      <div style={{ background:"#FFF8F2", border:"1px solid #E8D8C8", borderRadius:13, overflow:"hidden", marginBottom:18 }}>
        <div onClick={() => setHist(!histOpen)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 18px", cursor:"pointer", background:"#F5EEE6" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, fontWeight:700, fontSize:14, color:"#2C1810" }}>
            <Receipt size={16} /> ประวัติออเดอร์
            <span style={{ background:"#2C1810", color:"#FFF", borderRadius:20, padding:"1px 10px", fontSize:11 }}>{allOrders.length}</span>
            {allOrders.filter(o=>o.isCanceled).length > 0 && <span style={{ background:"#FDE8E8", color:"#C84B4B", borderRadius:20, padding:"1px 10px", fontSize:11 }}>ยกเลิก {allOrders.filter(o=>o.isCanceled).length}</span>}
          </div>
          {histOpen ? <ChevronUp size={16} color="#8C7C6C" /> : <ChevronDown size={16} color="#8C7C6C" />}
        </div>
        {histOpen && (
          <div style={{ padding:"0 18px 14px" }}>
            {allOrders.length===0 && <div style={{ textAlign:"center", color:"#9C8C7C", padding:"24px 0", fontSize:13 }}>ไม่มีออเดอร์</div>}
            {[...allOrders].reverse().map(order => (
              <div key={order.id} style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 0", borderBottom:"1px solid #EDE4DA", opacity:order.isCanceled?.6:1 }}>
                <div style={{ width:4, borderRadius:4, alignSelf:"stretch", background:order.isCanceled?"#C84B4B":"#7A9E6B", flexShrink:0, minHeight:36 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3, flexWrap:"wrap" }}>
                    <span style={{ background:order.isCanceled?"#FDE8E8":"#EDE6DC", color:order.isCanceled?"#C84B4B":"#6B4F3A", borderRadius:8, padding:"1px 8px", fontSize:12, fontWeight:700 }}>{order.orderNum?fmtNum(order.orderNum):`#${order.id.slice(-4).toUpperCase()}`}</span>
                    <span style={{ fontSize:11, color:"#9C8C7C" }}>{fmtDate(order.date)} {fmtTime(order.ts)}</span>
                    {order.isCanceled && <span style={{ background:"#FDE8E8", color:"#C84B4B", borderRadius:10, padding:"1px 8px", fontSize:10, fontWeight:700 }}>⊘ ยกเลิก</span>}
                  </div>
                  <div style={{ fontSize:11, color:"#8C7C6C", marginBottom:3, textDecoration:order.isCanceled?"line-through":"none" }}>{order.items.map(i=>`${i.name}(${i.variant})${i.note?` [${i.note}]`:""}×${i.qty}`).join(" · ")}</div>
                  <div style={{ fontSize:13, fontWeight:700, color:order.isCanceled?"#C84B4B":"#6B4F3A" }}>{baht(order.total)}</div>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:5, flexShrink:0 }}>
                  {!order.isCanceled && <button onClick={() => setConf({ type:"viewReceipt", order, rcpt })} style={{ background:"#EDE6DC", border:"none", borderRadius:8, padding:"5px 9px", fontSize:11, color:"#6B4F3A", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:3, whiteSpace:"nowrap" }}><Eye size={11} /> บิล</button>}
                  {!order.isCanceled && <button onClick={() => setConf({ type:"void", id:order.id, orderNum:order.orderNum })} style={{ background:"#FDE8E8", border:"none", borderRadius:8, padding:"5px 9px", fontSize:11, color:"#C84B4B", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:3, whiteSpace:"nowrap" }}><Ban size={11} /> ยกเลิก</button>}
                  {order.isCanceled && <button onClick={() => setConf({ type:"hardDelete", id:order.id, orderNum:order.orderNum })} style={{ background:"#FDE8E8", border:"none", borderRadius:8, padding:"5px 9px", fontSize:11, color:"#C84B4B", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:3, whiteSpace:"nowrap" }}><Trash2 size={11} /> ลบถาวร</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {confModal?.type==="void"        && <Overlay onClose={()=>setConf(null)}><ConfirmModal icon={<Ban size={36} color="#C84B4B" style={{margin:"0 auto 12px"}}/>} msg={`ยืนยันยกเลิกออเดอร์ ${confModal.orderNum?fmtNum(confModal.orderNum):""}?`} confirmLabel="ยืนยัน" confirmColor="#C84B4B" onConfirm={()=>{onVoid(confModal.id);setConf(null);}} onCancel={()=>setConf(null)}/></Overlay>}
      {confModal?.type==="hardDelete"  && <Overlay onClose={()=>setConf(null)}><ConfirmModal icon={<Trash2 size={36} color="#C84B4B" style={{margin:"0 auto 12px"}}/>} msg={"ลบออเดอร์ถาวร?\nข้อมูลจะหายไปจากระบบ"} confirmLabel="ลบถาวร" confirmColor="#C84B4B" onConfirm={()=>{onHardDelete(confModal.id);setConf(null);}} onCancel={()=>setConf(null)}/></Overlay>}
      {confModal?.type==="viewReceipt" && <Overlay onClose={()=>setConf(null)} wide><ChangeModal modal={{change:confModal.order.change,received:confModal.order.received,total:confModal.order.total,order:confModal.order,rcpt:confModal.rcpt}} onDismiss={()=>setConf(null)}/></Overlay>}
      {commitConfirm && (
        <Overlay onClose={() => setCommitConfirm(null)}>
          <div style={{ textAlign:"center" }}>
            <BookOpen size={36} color="#2C1810" style={{ margin:"0 auto 12px" }} />
            <div style={{ fontWeight:700, fontSize:16, color:"#2C1810", marginBottom:4 }}>ยืนยันการบันทึกลงบัญชี</div>
            <div style={{ fontSize:12, color:"#8C7C6C", marginBottom:16 }}>หมวดที่เลือก: {commitConfirm.items.map(s=>s.cat.name).join(", ")}</div>
            <div style={{ background:"#F5F0EA", borderRadius:12, padding:14, marginBottom:16 }}>
              {commitConfirm.items.map(s => (
                <div key={s.cat.id} style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:6, alignItems:"center" }}>
                  <span style={{ display:"flex", alignItems:"center", gap:6 }}><div style={{ width:8, height:8, borderRadius:"50%", background:s.cat.color }} />{s.cat.name} ({s.units} {s.unitName})</span>
                  <span style={{ fontWeight:600, color:"#6B4F3A" }}>{baht(s.rev)}</span>
                </div>
              ))}
              <div style={{ borderTop:"1px solid #D4C4B0", marginTop:8, paddingTop:8 }}>
                {[["ยอดขายรวม",baht(commitConfirm.totalRev),"#D4A574"],["ต้นทุนรวม",baht(commitConfirm.totalCost),"#C87941"],["กำไรสุทธิ",baht(commitConfirm.totalProfit),commitConfirm.totalProfit>=0?"#3A7A3A":"#C84B4B"]].map(([l,v,c]) => (
                  <div key={l} style={{ display:"flex", justifyContent:"space-between", fontSize:14, fontWeight:700, marginBottom:4 }}><span style={{ color:"#5C4A36" }}>{l}</span><span style={{ color:c }}>{v}</span></div>
                ))}
              </div>
            </div>
            <div style={{ fontSize:12, color:"#C87941", marginBottom:16 }}>⚠️ ยอดของหมวดที่เลือกจะรีเซ็ตเป็น 0 ทันที</div>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={() => setCommitConfirm(null)} style={{ flex:1, background:"#F0E8DC", color:"#5C4A36", border:"none", borderRadius:10, padding:"11px", fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>ยกเลิก</button>
              <button onClick={handleCommitConfirm} style={{ flex:1, background:"#2C1810", color:"#FFF", border:"none", borderRadius:10, padding:"11px", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>✅ ยืนยันการบันทึก</button>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// LEDGER VIEW — improved cash management with full transaction history
// ─────────────────────────────────────────────────────────────
function LedgerView({ ledger, cash, data, dispDate, onUndoEntry, onAddCashTx }) {
  const [ledgerDate, setLedgerDate] = useState(dispDate);
  const [cashModal,  setCashModal]  = useState(null);
  const [confirmUndo, setConfirmUndo] = useState(null);

  // Cash transactions only (initial / expense / withdrawal)
  const cashTxAll = ledger.filter(e => ["initial","expense","withdrawal"].includes(e.type))
                          .sort((a,b) => new Date(b.ts) - new Date(a.ts));

  // Day entries for the left panel
  const dayEntries = ledger
    .filter(e => (e.ts?.startsWith(ledgerDate)) || e.date === ledgerDate)
    .sort((a,b) => new Date(b.ts) - new Date(a.ts));

  const daySummary = dayEntries.reduce((acc, e) => {
    if (e.type==="category")   { acc.revenue+=(e.revenue||0); acc.cost+=(e.cost||0); acc.profit+=(e.netProfit||0); acc.units+=(e.units||0); }
    if (e.type==="expense")      acc.expense    += (e.amount||0);
    if (e.type==="withdrawal")   acc.withdrawal += (e.amount||0);
    return acc;
  }, { revenue:0, cost:0, profit:0, units:0, expense:0, withdrawal:0 });

  // Type label and color
  const typeInfo = {
    category:   { label: "บันทึกยอดขาย", color: "#7A9E6B", dot: "#7A9E6B"  },
    initial:    { label: "ตั้งค่าเงินเริ่มต้น", color: "#4179C8", dot: "#4179C8" },
    expense:    { label: "จ่ายทุน",       color: "#C87941", dot: "#C87941" },
    withdrawal: { label: "ถอนกำไร",       color: "#7941C8", dot: "#7941C8" },
  };

  return (
    <div style={{ display:"flex", flex:1, overflow:"hidden", height:"calc(100vh - 50px)" }}>
      {/* LEFT 60% — Accounting Records */}
      <div style={{ flex:"0 0 60%", overflowY:"auto", padding:"20px 18px", borderRight:"1px solid #E4D4C0", background:"#F5F0EA" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18 }}>
          <div style={{ fontWeight:700, fontSize:18, color:"#2C1810", display:"flex", alignItems:"center", gap:7 }}><BookOpen size={19} color="#D4A574" /> รายการบัญชี</div>
          <div style={{ flex:1 }} />
          <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:13, color:"#5C4A36" }}>
            <CalendarDays size={13} />
            <input type="date" value={ledgerDate} onChange={e => setLedgerDate(e.target.value)} style={{ padding:"4px 8px", borderRadius:8, border:"1px solid #D4C4B0", background:"#FFF8F2", color:"#2C1810", fontSize:13 }} />
          </label>
        </div>

        {dayEntries.length === 0
          ? <EmptyMsg label="ยังไม่มีรายการบัญชีในวันนี้" />
          : (
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:16 }}>
              {dayEntries.map(e => {
                const info = typeInfo[e.type] || { label:e.type, color:"#8C7C6C", dot:"#8C7C6C" };
                return (
                  <div key={e.id} style={{ background:"#FFF8F2", border:"1px solid #E8D8C8", borderRadius:12, padding:"10px 14px", display:"flex", alignItems:"flex-start", gap:10 }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background:info.dot, flexShrink:0, marginTop:6 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, flexWrap:"wrap" }}>
                        <span style={{ fontWeight:700, fontSize:13, color:"#2C1810" }}>{e.type==="category"?(e.catName||"หมวดรวม"):info.label}</span>
                        <span style={{ fontSize:11, color:"#9C8C7C" }}>{fmtTime(e.ts)}</span>
                        <span style={{ fontSize:10, background:"#F0E8DC", color:"#6B4F3A", borderRadius:8, padding:"1px 7px" }}>{info.label}</span>
                      </div>
                      {e.type==="category" && (
                        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6 }}>
                          {[["จำนวน",`${e.units||0} ${e.unitName||"รายการ"}`,"#6B4F3A"],["ยอดขาย",baht(e.revenue),"#D4A574"],["ทุน",baht(e.cost),"#C87941"],["กำไร",baht(e.netProfit),(e.netProfit||0)>=0?"#3A7A3A":"#C84B4B"]].map(([l,v,c]) => (
                            <div key={l} style={{ background:"#F5F0EA", borderRadius:7, padding:"5px 8px", textAlign:"center" }}>
                              <div style={{ fontSize:10, color:"#8C7C6C" }}>{l}</div>
                              <div style={{ fontSize:13, fontWeight:700, color:c }}>{v}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {e.type==="initial"    && <div style={{ fontSize:13, color:"#4179C8", fontWeight:600 }}>ทุน {baht(e.capital)} · กำไร {baht(e.profit)}</div>}
                      {e.type==="expense"    && <div style={{ fontSize:13, color:"#C87941", fontWeight:700 }}>จ่ายทุน: {baht(e.amount)}{e.desc?<span style={{ color:"#8C7C6C", fontWeight:400 }}> — {e.desc}</span>:""}</div>}
                      {e.type==="withdrawal" && <div style={{ fontSize:13, color:"#7941C8", fontWeight:700 }}>ถอนกำไร: {baht(e.amount)}</div>}
                    </div>
                    <button onClick={() => setConfirmUndo(e)} style={{ background:"#FDE8E8", border:"none", borderRadius:8, padding:"5px 8px", cursor:"pointer", color:"#C84B4B", flexShrink:0, display:"flex", alignItems:"center", gap:3, fontSize:11, fontFamily:"inherit" }}>
                      <Undo2 size={11} /> ยกเลิก
                    </button>
                  </div>
                );
              })}
            </div>
          )}

        {/* Daily Summary */}
        <div style={{ background:"#2C1810", borderRadius:13, padding:"14px 16px" }}>
          <div style={{ fontWeight:700, fontSize:13, color:"#D4A574", marginBottom:10 }}>สรุปยอดรายวัน — {fmtDateS(ledgerDate)}</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:8 }}>
            {[["ยอดขาย",baht(daySummary.revenue),"#D4A574"],["ทุน",baht(daySummary.cost),"#C87941"],["กำไร",baht(daySummary.profit),daySummary.profit>=0?"#6CC97A":"#C96C6C"]].map(([l,v,c]) => (
              <div key={l} style={{ background:"rgba(255,255,255,.07)", borderRadius:9, padding:"8px 10px", textAlign:"center" }}>
                <div style={{ fontSize:10, color:"rgba(255,255,255,.6)" }}>{l}</div>
                <div style={{ fontSize:16, fontWeight:700, color:c }}>{v}</div>
              </div>
            ))}
          </div>
          {(daySummary.expense>0||daySummary.withdrawal>0) && (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div style={{ background:"rgba(255,255,255,.07)", borderRadius:9, padding:"7px 10px", textAlign:"center" }}><div style={{ fontSize:10, color:"rgba(255,255,255,.6)" }}>รายจ่าย</div><div style={{ fontSize:15, fontWeight:700, color:"#C87941" }}>-{baht(daySummary.expense)}</div></div>
              <div style={{ background:"rgba(255,255,255,.07)", borderRadius:9, padding:"7px 10px", textAlign:"center" }}><div style={{ fontSize:10, color:"rgba(255,255,255,.6)" }}>ถอนกำไร</div><div style={{ fontSize:15, fontWeight:700, color:"#7941C8" }}>-{baht(daySummary.withdrawal)}</div></div>
            </div>
          )}
        </div>
      </div>

      {/* RIGHT 40% — Cash Management */}
      <div style={{ flex:"0 0 40%", overflowY:"auto", padding:"20px 16px", background:"#FFF8F2" }}>
        <div style={{ fontWeight:700, fontSize:16, color:"#2C1810", marginBottom:14, display:"flex", alignItems:"center", gap:7 }}><Wallet size={17} color="#D4A574" /> บริหารเงินสด</div>

        {/* Total cash box */}
        <div style={{ background:"#2C1810", borderRadius:14, padding:"16px", marginBottom:12, textAlign:"center" }}>
          <div style={{ fontSize:12, color:"#C8A882", marginBottom:6 }}>ยอดเงินรวม (ทุน + กำไร)</div>
          <div style={{ fontSize:32, fontWeight:700, color:"#D4A574" }}>{baht(cash.total)}</div>
        </div>

        {/* Capital / Profit breakdown */}
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:16 }}>
          {[["เงินทุนคงเหลือ",cash.capital,"#C87941",<PiggyBank size={16}/>],["กำไรสะสม",cash.profit,cash.profit>=0?"#3A7A3A":"#C84B4B",<ArrowUpCircle size={16}/>]].map(([l,v,c,ic]) => (
            <div key={l} style={{ background:"#F5F0EA", border:"1px solid #E8D8C8", borderRadius:13, padding:"12px 14px", display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ color:c }}>{ic}</div>
              <div style={{ flex:1 }}><div style={{ fontSize:11, color:"#8C7C6C" }}>{l}</div><div style={{ fontSize:22, fontWeight:700, color:c }}>{baht(v)}</div></div>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:20 }}>
          <button onClick={() => setCashModal("init")}       style={{ background:"#2C1810", color:"#FFF", border:"none", borderRadius:11, padding:"11px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}><Settings size={14} /> ตั้งค่าเงินเริ่มต้น</button>
          <button onClick={() => setCashModal("expense")}    style={{ background:"#C87941", color:"#FFF", border:"none", borderRadius:11, padding:"11px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}><ArrowDownCircle size={14} /> จ่ายทุน (Expense)</button>
          <button onClick={() => setCashModal("withdrawal")} style={{ background:"#7941C8", color:"#FFF", border:"none", borderRadius:11, padding:"11px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}><ArrowUpCircle size={14} /> ถอนกำไร (Withdrawal)</button>
        </div>

        {/* Cash transaction history */}
        {cashTxAll.length > 0 && (
          <div>
            <div style={{ fontWeight:600, fontSize:13, color:"#2C1810", marginBottom:10, display:"flex", alignItems:"center", gap:6 }}><History size={14} /> ประวัติการขยับเงิน</div>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {cashTxAll.slice(0, 10).map(e => {
                const info = typeInfo[e.type] || { label:e.type, color:"#8C7C6C" };
                return (
                  <div key={e.id} style={{ background:"#F5F0EA", borderRadius:10, padding:"9px 12px", display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:6, height:6, borderRadius:"50%", background:info.color, flexShrink:0 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12, fontWeight:600, color:"#2C1810" }}>{info.label}</div>
                      <div style={{ fontSize:11, color:"#8C7C6C" }}>{fmtDT(e.ts)}</div>
                      {e.type==="initial"    && <div style={{ fontSize:11, color:"#4179C8" }}>ทุน {baht(e.capital)} · กำไร {baht(e.profit)}</div>}
                      {e.type==="expense"    && <div style={{ fontSize:11, color:"#C87941", fontWeight:700 }}>-{baht(e.amount)}{e.desc?` — ${e.desc}`:""}</div>}
                      {e.type==="withdrawal" && <div style={{ fontSize:11, color:"#7941C8", fontWeight:700 }}>-{baht(e.amount)}</div>}
                    </div>
                    <button onClick={() => setConfirmUndo(e)} style={{ background:"#FDE8E8", border:"none", borderRadius:7, padding:"4px 7px", cursor:"pointer", color:"#C84B4B", fontSize:10, fontFamily:"inherit", display:"flex", alignItems:"center", gap:2 }}>
                      <Undo2 size={10} /> ยกเลิก
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Cash Modals */}
      {cashModal==="init"       && <Overlay onClose={() => setCashModal(null)}><CashInitModal onClose={() => setCashModal(null)} onSave={(cap, prof) => { onAddCashTx({ type:"initial", capital:cap, profit:prof, date:dispDate }); setCashModal(null); }} /></Overlay>}
      {cashModal==="expense"    && <Overlay onClose={() => setCashModal(null)}><ExpenseModal    onClose={() => setCashModal(null)} onSave={(amt, desc) => { onAddCashTx({ type:"expense",    amount:amt, desc, date:dispDate }); setCashModal(null); }} /></Overlay>}
      {cashModal==="withdrawal" && <Overlay onClose={() => setCashModal(null)}><WithdrawalModal onClose={() => setCashModal(null)} onSave={amt => { onAddCashTx({ type:"withdrawal", amount:amt, date:dispDate }); setCashModal(null); }} /></Overlay>}

      {/* Confirm undo */}
      {confirmUndo && (
        <Overlay onClose={() => setConfirmUndo(null)}>
          <ConfirmModal
            icon={<Undo2 size={36} color="#C84B4B" style={{ margin:"0 auto 12px" }} />}
            msg={`ยืนยันการยกเลิกรายการ "${typeInfo[confirmUndo.type]?.label||confirmUndo.type}"?\n\nยอดเงินจะถูกคืนกลับสู่ระบบอัตโนมัติ`}
            confirmLabel="ยืนยันยกเลิก"
            confirmColor="#C84B4B"
            onConfirm={() => { onUndoEntry(confirmUndo.id); setConfirmUndo(null); }}
            onCancel={() => setConfirmUndo(null)} />
        </Overlay>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// RECEIPT SETTINGS
// ─────────────────────────────────────────────────────────────
function ReceiptSettingsView({ settings, onSave }) {
  const [form, setForm]   = useState({ ...settings });
  const [saved, setSaved] = useState(false);
  const logoRef = useRef();
  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const handleLogo = e => { const f = e.target.files?.[0]; if(!f) return; const r = new FileReader(); r.onload = ev => upd("logo", ev.target.result); r.readAsDataURL(f); };
  const save = () => { onSave(form); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  return (
    <div style={{ flex:1, overflowY:"auto", padding:"20px 24px", maxWidth:560 }}>
      <div style={{ fontWeight:700, fontSize:19, color:"#2C1810", marginBottom:20, display:"flex", alignItems:"center", gap:8 }}><Settings size={19} /> ตั้งค่าใบเสร็จ</div>
      <div style={{ background:"#FFF8F2", border:"1px solid #E8D8C8", borderRadius:14, padding:22, display:"flex", flexDirection:"column", gap:14 }}>
        <Field label="โลโก้ร้าน">
          <div style={{ display:"flex", gap:12, alignItems:"center" }}>
            {form.logo && <img src={form.logo} alt="logo" style={{ width:60, height:60, borderRadius:10, objectFit:"contain", background:"#F5F0EA", padding:4 }} />}
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <button onClick={() => logoRef.current?.click()} style={{ background:"#F0E8DC", border:"1px solid #D4C4B0", borderRadius:8, padding:"7px 14px", fontSize:13, cursor:"pointer", color:"#5C4A36", fontFamily:"inherit", display:"flex", alignItems:"center", gap:5 }}><Camera size={12} /> อัปโหลดโลโก้</button>
              {form.logo && <button onClick={() => upd("logo",null)} style={{ background:"none", border:"none", color:"#C84B4B", cursor:"pointer", fontSize:12, fontFamily:"inherit", textAlign:"left" }}>ลบโลโก้</button>}
            </div>
            <input ref={logoRef} type="file" accept="image/*" style={{ display:"none" }} onChange={handleLogo} />
          </div>
        </Field>
        <Field label="ชื่อร้าน"><input value={form.shopName} onChange={e => upd("shopName",e.target.value)} style={iStyle} /></Field>
        <Field label="ชื่อพนักงาน"><input value={form.staffName||""} onChange={e => upd("staffName",e.target.value)} placeholder="เช่น น้องมิ้ว" style={iStyle} /></Field>
        <Field label="ข้อความขอบคุณ"><input value={form.thankMsg} onChange={e => upd("thankMsg",e.target.value)} style={iStyle} /></Field>
        <button onClick={save} style={{ background:"#2C1810", color:"#FFF", border:"none", borderRadius:11, padding:"12px", fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:7 }}>
          {saved ? <><CheckCircle size={16} /> บันทึกแล้ว!</> : "บันทึกการตั้งค่า"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PAYMENT MODAL
// ─────────────────────────────────────────────────────────────
function PaymentModal({ modal, setModal, cartTotal, onConfirm }) {
  const [disp, setDisp] = useState(modal.received || "");
  const rcv = parseInt(disp || "0", 10);
  const press = v => {
    if (v==="C") { setDisp(""); setModal(m => ({ ...m, received:"" })); return; }
    if (v==="⌫") { const n=disp.slice(0,-1); setDisp(n); setModal(m => ({ ...m, received:n })); return; }
    const n=disp+v; setDisp(n); setModal(m => ({ ...m, received:n }));
  };
  const shortcut = val => { const n=String(rcv+val); setDisp(n); setModal(m => ({ ...m, received:n })); };
  return (
    <div>
      <div style={{ fontWeight:700, fontSize:16, color:"#2C1810", marginBottom:4 }}>รับเงิน</div>
      <div style={{ fontSize:13, color:"#8C7C6C", marginBottom:12 }}>ยอดชำระ: {baht(cartTotal)}</div>
      <div style={{ background:"#F5F0EA", borderRadius:12, padding:"12px 14px", fontSize:26, fontWeight:700, color:"#2C1810", textAlign:"right", marginBottom:12, minHeight:52 }}>
        {disp ? baht(parseInt(disp,10)) : <span style={{ color:"#C0B0A0", fontSize:18 }}>ใส่จำนวนเงิน</span>}
      </div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:11 }}>
        {[10,20,50,100,500,1000].map(v => <button key={v} onClick={() => shortcut(v)} style={{ flex:"1 1 74px", background:"#EDE6DC", border:"none", borderRadius:9, padding:"9px 4px", fontSize:14, fontWeight:600, color:"#6B4F3A", cursor:"pointer", fontFamily:"inherit" }}>+{v}</button>)}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:12 }}>
        {["1","2","3","4","5","6","7","8","9","C","0","⌫"].map(v => (
          <button key={v} onClick={() => press(v)} style={{ background:v==="C"?"#FDE8E8":v==="⌫"?"#F0E8DC":"#F5F0EA", border:"1px solid #E4D4C0", borderRadius:9, padding:"13px", fontSize:v==="⌫"?16:18, fontWeight:600, color:v==="C"?"#C84B4B":"#2C1810", cursor:"pointer", fontFamily:"inherit" }}>{v}</button>
        ))}
      </div>
      {rcv>0&&rcv>=cartTotal&&<div style={{ background:"#EDF7ED", border:"1px solid #A8D8A8", borderRadius:10, padding:"9px 14px", marginBottom:12, display:"flex", justifyContent:"space-between", alignItems:"center" }}><span style={{ color:"#3A7A3A", fontSize:13 }}>เงินทอน</span><span style={{ color:"#2A6A2A", fontWeight:700, fontSize:18 }}>{baht(rcv-cartTotal)}</span></div>}
      <button onClick={onConfirm} disabled={rcv<cartTotal} style={{ width:"100%", background:rcv>=cartTotal?"#2C1810":"#C0B0A0", color:"#FFF", border:"none", borderRadius:12, padding:"13px", fontSize:16, fontWeight:700, cursor:rcv>=cartTotal?"pointer":"not-allowed", fontFamily:"inherit" }}>✅ ยืนยันรับเงิน</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CHANGE MODAL + RECEIPT (JPG export)
// ─────────────────────────────────────────────────────────────
function ChangeModal({ modal, onDismiss }) {
  const [showR, setShowR]   = useState(false);
  const [saving, setSaving] = useState(false);
  const receiptRef = useRef();
  const { order, rcpt={} } = modal;
  const shop     = rcpt.shopName  || "RoomTwo Coffee";
  const staff    = rcpt.staffName || "";
  const thankMsg = rcpt.thankMsg  || "ขอบคุณที่ใช้บริการ 🙏";
  const logo     = rcpt.logo      || null;
  const isChange = modal.change !== undefined && modal.received !== undefined;

  const saveJpg = async () => {
    setShowR(true); setSaving(true);
    await new Promise(r => setTimeout(r, 400));
    try {
      if (window.html2canvas && receiptRef.current) {
        const canvas = await window.html2canvas(receiptRef.current, { backgroundColor:"#ffffff", scale:2.5, useCORS:true, logging:false });
        const link = document.createElement("a");
        link.download = `receipt-${order?.orderNum?String(order.orderNum).padStart(3,"0"):order?.id?.slice(-4)||"x"}-${order?.date||"x"}.jpg`;
        link.href = canvas.toDataURL("image/jpeg", .92);
        link.click();
      }
    } catch(e) {}
    setSaving(false);
  };

  return (
    <div style={{ textAlign:"center", padding:"4px 0" }}>
      {isChange && (
        <>
          <div style={{ fontSize:44, marginBottom:10 }}>✅</div>
          <div style={{ fontWeight:700, fontSize:17, color:"#2C1810", marginBottom:4 }}>ชำระเงินสำเร็จ</div>
          <div style={{ fontSize:12, color:"#8C7C6C", marginBottom:18 }}>รับ {baht(modal.received)} · ยอด {baht(modal.total)}</div>
          <div style={{ background:"#F5F0EA", borderRadius:14, padding:"18px 22px", marginBottom:18 }}>
            <div style={{ fontSize:13, color:"#8C7C6C", marginBottom:4 }}>เงินทอน</div>
            <div style={{ fontSize:44, fontWeight:700, color:"#2C1810" }}>{baht(modal.change)}</div>
          </div>
        </>
      )}
      <div style={{ display:"flex", gap:10, marginBottom:showR?16:0 }}>
        <button onClick={saveJpg} disabled={saving} style={{ flex:1, background:"#EDE6DC", color:"#5C4A36", border:"none", borderRadius:12, padding:"12px", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:6, opacity:saving?.7:1 }}><ImageDown size={14} />{saving?"กำลังบันทึก...":"บันทึกบิล (.jpg)"}</button>
        <button onClick={onDismiss} style={{ flex:1, background:"#2C1810", color:"#F5E8D8", border:"none", borderRadius:12, padding:"12px", fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>{isChange?"รับทราบ":"ปิด"}</button>
      </div>
      {showR && order && (
        <div style={{ borderRadius:12, overflow:"hidden", border:"1px solid #D4C4B0" }}>
          <div style={{ background:"#EDE6DC", padding:"6px 14px", fontSize:11, color:"#6B4F3A", textAlign:"left", display:"flex", alignItems:"center", gap:5 }}><ImageDown size={11} /> แคปหน้าจอส่งต่อได้เลย</div>
          <div ref={receiptRef} style={{ background:"#fff", color:"#000", fontFamily:"'Sarabun','Noto Sans Thai',sans-serif", padding:"20px 18px", textAlign:"center", width:"100%" }}>
            {logo ? <><img src={logo} alt="logo" style={{ width:70, height:70, objectFit:"contain", margin:"0 auto 6px", display:"block" }} /><div style={{ fontWeight:700, fontSize:16 }}>{shop}</div></> : <div style={{ fontWeight:700, fontSize:19, letterSpacing:"0.04em" }}>{shop}</div>}
            {staff && <div style={{ fontSize:12, color:"#444", marginTop:2 }}>พนักงาน: {staff}</div>}
            <div style={{ fontSize:12, color:"#555", marginTop:2 }}>ใบเสร็จรับเงิน / Receipt</div>
            <div style={{ borderTop:"1px dashed #aaa", margin:"10px 0" }} />
            <div style={{ textAlign:"left", fontSize:12, color:"#333", lineHeight:1.9 }}>
              <div>เลขที่บิล: <b>{order.orderNum?fmtNum(order.orderNum):`#${order.id?.slice(-4).toUpperCase()}`}</b></div>
              <div>วันที่: {fmtDate(order.date)}</div>
              <div>เวลา: {fmtTime(order.ts)}</div>
            </div>
            <div style={{ borderTop:"1px dashed #aaa", margin:"10px 0" }} />
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13, textAlign:"left" }}>
              <thead><tr style={{ borderBottom:"1px solid #ccc" }}><th style={{ padding:"3px 0", fontWeight:600 }}>รายการ</th><th style={{ textAlign:"center", fontWeight:600 }}>จำนวน</th><th style={{ textAlign:"right", fontWeight:600 }}>ราคา</th></tr></thead>
              <tbody>
                {order.items.map((item,i) => (
                  <tr key={i}>
                    <td style={{ padding:"3px 0", lineHeight:1.5 }}>{item.name} <span style={{ color:"#666", fontSize:11 }}>({item.variant})</span>{item.note&&<div style={{ fontSize:10, color:"#888" }}>— {item.note}</div>}</td>
                    <td style={{ textAlign:"center" }}>{item.qty} {item.unit||""}</td>
                    <td style={{ textAlign:"right" }}>฿{(item.price*item.qty).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ borderTop:"1px solid #aaa", marginTop:8, paddingTop:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontWeight:700, fontSize:15 }}><span>ยอดรวม</span><span>฿{order.total?.toLocaleString()}</span></div>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#555", marginTop:3 }}><span>รับเงิน</span><span>฿{order.received?.toLocaleString()}</span></div>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#555" }}><span>เงินทอน</span><span>฿{(order.change||0).toLocaleString()}</span></div>
            </div>
            <div style={{ borderTop:"1px dashed #aaa", margin:"10px 0" }} />
            <div style={{ fontSize:12, color:"#444" }}>{thankMsg}</div>
            <div style={{ fontSize:12, color:"#555", marginTop:3 }}>★ {shop} ★</div>
          </div>
          <div style={{ background:"#EDE6DC", padding:"5px 14px", display:"flex", justifyContent:"flex-end" }}><button onClick={() => setShowR(false)} style={{ background:"none", border:"none", fontSize:12, color:"#6B4F3A", cursor:"pointer", fontFamily:"inherit" }}>ปิด</button></div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CATEGORY / PRODUCT / ADDON FORMS
// ─────────────────────────────────────────────────────────────
function AddCatModal({ data, persist, onClose }) {
  const [name, setName] = useState(""); const [color, setColor] = useState(PALETTE[0]);
  return <div><ModalTitle>➕ เพิ่มหมวดหมู่</ModalTitle><Field label="ชื่อ"><input value={name} onChange={e=>setName(e.target.value)} placeholder="เช่น กาแฟ" style={iStyle}/></Field><Field label="สี"><ColorPicker value={color} onChange={setColor}/></Field><ModalFooter onCancel={onClose} onSave={() => { if(!name.trim())return; persist({...data,categories:[...data.categories,{id:`cat${uid()}`,name:name.trim(),color,order:data.categories.length}]},true); onClose(); }}/></div>;
}
function EditCatModal({ cat, data, persist, onClose }) {
  const [name, setName] = useState(cat.name); const [color, setColor] = useState(cat.color);
  return <div><ModalTitle>✏️ แก้ไขหมวดหมู่</ModalTitle><Field label="ชื่อ"><input value={name} onChange={e=>setName(e.target.value)} style={iStyle}/></Field><Field label="สี"><ColorPicker value={color} onChange={setColor}/></Field><ModalFooter onCancel={onClose} onSave={() => { if(!name.trim())return; persist({...data,categories:data.categories.map(c=>c.id===cat.id?{...c,name:name.trim(),color}:c)},true); onClose(); }}/></div>;
}
function AddonFormModal({ addon, data, persist, onClose }) {
  const [name, setName]   = useState(addon?.name || "");
  const [price, setPrice] = useState(addon ? String(addon.price) : "");
  const [cats, setCats]   = useState(addon?.categoryIds || []);
  const sc = data.categories.slice().sort((a,b) => a.order-b.order);
  const save = () => {
    if (!name.trim() || !price) return;
    const addons = data.addons || [];
    const newAo = { id: addon?addon.id:`ao${uid()}`, name:name.trim(), price:parseFloat(price), categoryIds:cats };
    persist({ ...data, addons: addon ? addons.map(a=>a.id===addon.id?newAo:a) : [...addons,newAo] }, true);
    onClose();
  };
  return (
    <div>
      <ModalTitle>{addon?"✏️ แก้ไข":"🏷️ เพิ่ม"} Add-on</ModalTitle>
      <Field label="ชื่อ Add-on"><input value={name} onChange={e=>setName(e.target.value)} placeholder="เช่น เพิ่มช็อต" style={iStyle}/></Field>
      <Field label="ราคา (฿)"><input value={price} onChange={e=>setPrice(e.target.value)} type="number" style={iStyle}/></Field>
      <Field label="แสดงในหมวดหมู่">
        <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginTop:4 }}>
          {sc.map(c => <button key={c.id} onClick={()=>setCats(prev=>prev.includes(c.id)?prev.filter(x=>x!==c.id):[...prev,c.id])} style={{ background:cats.includes(c.id)?c.color:"#F0E8DC", color:cats.includes(c.id)?"#FFF":"#5C4A36", border:`1.5px solid ${cats.includes(c.id)?c.color:"#D4C4B0"}`, borderRadius:20, padding:"5px 14px", fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>{cats.includes(c.id)?"✓ ":""}{c.name}</button>)}
        </div>
      </Field>
      <ModalFooter onCancel={onClose} onSave={save}/>
    </div>
  );
}

function EditProdModal({ prod, data, persist, onClose }) {
  const [name,setName]=useState(prod.name); const [color,setColor]=useState(prod.color); const [catId,setCatId]=useState(prod.categoryId); const [unit,setUnit]=useState(prod.unit||"");
  const [vars,setVars]=useState(prod.variants.map(v=>({...v,price:String(v.price)}))); const [mgs,setMgs]=useState(prod.modifierGroups||[]); const [image,setImage]=useState(prod.image); const fr=useRef();
  const aV=()=>setVars(v=>[...v,{id:`v${uid()}`,name:"",price:""}]); const rV=id=>setVars(v=>v.filter(x=>x.id!==id)); const uV=(id,f,val)=>setVars(v=>v.map(x=>x.id===id?{...x,[f]:val}:x));
  const ip=e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>setImage(ev.target.result);r.readAsDataURL(f);};
  const save=()=>{ if(!name.trim())return; const vts=vars.filter(v=>v.name.trim()&&v.price!=="").map(v=>({...v,price:parseFloat(v.price)})); if(!vts.length)return; persist({...data,products:data.products.map(p=>p.id===prod.id?{...p,name:name.trim(),color,categoryId:catId,unit,variants:vts,modifierGroups:mgs,image}:p)},true); onClose(); };
  return <ProdForm title="✏️ แก้ไขสินค้า" name={name} setName={setName} color={color} setColor={setColor} catId={catId} setCatId={setCatId} unit={unit} setUnit={setUnit} vars={vars} addV={aV} remV={rV} updV={uV} mgs={mgs} setMgs={setMgs} image={image} setImage={setImage} fr={fr} ip={ip} data={data} onClose={onClose} save={save} />;
}
function AddProdModal({ data, persist, catId, onClose }) {
  const [name,setName]=useState(""); const [color,setColor]=useState(PALETTE[4]); const [cat,setCat]=useState(catId||data.categories[0]?.id||""); const [unit,setUnit]=useState("");
  const [vars,setVars]=useState([{id:"v1",name:"ปกติ",price:""}]); const [mgs,setMgs]=useState([]); const [image,setImage]=useState(null); const fr=useRef();
  const aV=()=>setVars(v=>[...v,{id:`v${uid()}`,name:"",price:""}]); const rV=id=>setVars(v=>v.filter(x=>x.id!==id)); const uV=(id,f,val)=>setVars(v=>v.map(x=>x.id===id?{...x,[f]:val}:x));
  const ip=e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>setImage(ev.target.result);r.readAsDataURL(f);};
  const save=()=>{ if(!name.trim()||!cat)return; const vts=vars.filter(v=>v.name.trim()&&v.price!=="").map(v=>({...v,price:parseFloat(v.price)})); if(!vts.length)return; persist({...data,products:[...data.products,{id:`p${uid()}`,categoryId:cat,name:name.trim(),color,image,unit,variants:vts,modifierGroups:mgs,order:data.products.filter(p=>p.categoryId===cat).length}]},true); onClose(); };
  return <ProdForm title="➕ เพิ่มสินค้า" name={name} setName={setName} color={color} setColor={setColor} catId={cat} setCatId={setCat} unit={unit} setUnit={setUnit} vars={vars} addV={aV} remV={rV} updV={uV} mgs={mgs} setMgs={setMgs} image={image} setImage={setImage} fr={fr} ip={ip} data={data} onClose={onClose} save={save} />;
}

function ModGroupEditor({ mgs, setMgs }) {
  const aG=()=>setMgs(g=>[...g,{id:`mg${uid()}`,name:"",options:[]}]);
  const rG=id=>setMgs(g=>g.filter(x=>x.id!==id));
  const uGN=(id,v)=>setMgs(g=>g.map(x=>x.id===id?{...x,name:v}:x));
  const aO=gid=>setMgs(g=>g.map(x=>x.id===gid?{...x,options:[...x.options,{id:`o${uid()}`,label:""}]}:x));
  const rO=(gid,oid)=>setMgs(g=>g.map(x=>x.id===gid?{...x,options:x.options.filter(o=>o.id!==oid)}:x));
  const uO=(gid,oid,v)=>setMgs(g=>g.map(x=>x.id===gid?{...x,options:x.options.map(o=>o.id===oid?{...o,label:v}:o)}:x));
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <div style={{ fontSize:12, color:"#8C7C6C", fontWeight:500 }}>กลุ่มตัวเลือกเสริม (ไม่คิดเงิน)</div>
        <button onClick={aG} style={{ background:"#F0E8DC", border:"none", borderRadius:8, padding:"4px 10px", fontSize:12, color:"#5C4A36", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:4 }}><Plus size={11} /> เพิ่มกลุ่ม</button>
      </div>
      {mgs.map(g => (
        <div key={g.id} style={{ background:"#F5F0EA", borderRadius:10, padding:"10px 12px", marginBottom:8, border:"1px solid #D4C4B0" }}>
          <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:8 }}>
            <input value={g.name} onChange={e=>uGN(g.id,e.target.value)} placeholder="ชื่อกลุ่ม เช่น ความหวาน" style={{...iStyle,flex:1,fontSize:13,padding:"6px 10px"}}/>
            <button onClick={()=>rG(g.id)} style={{ background:"#FDE8E8", border:"none", borderRadius:7, padding:"5px 8px", cursor:"pointer", color:"#C84B4B" }}><Trash2 size={12}/></button>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:6, marginBottom:6 }}>
            {g.options.map(o => (
              <div key={o.id} style={{ display:"flex", gap:4, alignItems:"center" }}>
                <input value={o.label} onChange={e=>uO(g.id,o.id,e.target.value)} placeholder="ตัวเลือก" style={{...iStyle,fontSize:12,padding:"5px 8px",flex:1}}/>
                <button onClick={()=>rO(g.id,o.id)} style={{ background:"#FDE8E8", border:"none", borderRadius:6, padding:"4px 6px", cursor:"pointer", color:"#C84B4B" }}><X size={10}/></button>
              </div>
            ))}
          </div>
          <button onClick={()=>aO(g.id)} style={{ background:"none", border:"1px dashed #C4B4A0", borderRadius:7, padding:"5px", fontSize:12, color:"#8C7C6C", cursor:"pointer", fontFamily:"inherit", width:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:4 }}><Plus size={11}/> เพิ่มตัวเลือก</button>
        </div>
      ))}
    </div>
  );
}

function ProdForm({ title,name,setName,color,setColor,catId,setCatId,unit,setUnit,vars,addV,remV,updV,mgs,setMgs,image,setImage,fr,ip,data,onClose,save }) {
  return (
    <div>
      <ModalTitle>{title}</ModalTitle>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
        <Field label="ชื่อสินค้า"><input value={name} onChange={e=>setName(e.target.value)} placeholder="เช่น ลาเต้" style={iStyle}/></Field>
        <Field label="หมวดหมู่"><select value={catId} onChange={e=>setCatId(e.target.value)} style={iStyle}>{data.categories.slice().sort((a,b)=>a.order-b.order).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      </div>
      <Field label={<span>หน่วยนับ <span style={{color:"#C84B4B"}}>*</span> (เช่น แก้ว, ชิ้น)</span>}><input value={unit} onChange={e=>setUnit(e.target.value)} placeholder="กรอกหน่วยนับ" style={iStyle}/></Field>
      <Field label="สี"><ColorPicker value={color} onChange={setColor}/></Field>
      <Field label="ภาพ (ไม่บังคับ)">
        <div style={{ display:"flex", gap:9, alignItems:"center" }}>
          {image && <img src={image} alt="" style={{ width:42, height:42, borderRadius:9, objectFit:"cover" }}/>}
          <button onClick={()=>fr.current?.click()} style={{ background:"#F0E8DC", border:"1px solid #D4C4B0", borderRadius:8, padding:"6px 13px", fontSize:13, cursor:"pointer", color:"#5C4A36", fontFamily:"inherit", display:"flex", alignItems:"center", gap:5 }}><Camera size={12}/> เลือกภาพ</button>
          <input ref={fr} type="file" accept="image/*" style={{ display:"none" }} onChange={ip}/>
          {image && <button onClick={()=>setImage(null)} style={{ background:"none", border:"none", color:"#C84B4B", cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>ลบ</button>}
        </div>
      </Field>
      <Field label="รูปแบบและราคา">
        <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
          {vars.map(v => (
            <div key={v.id} style={{ display:"flex", gap:8, alignItems:"center" }}>
              <input value={v.name} onChange={e=>updV(v.id,"name",e.target.value)} placeholder="เช่น ร้อน" style={{...iStyle,flex:2}}/>
              <input value={v.price} onChange={e=>updV(v.id,"price",e.target.value)} placeholder="฿" type="number" style={{...iStyle,flex:1}}/>
              {vars.length>1 && <button onClick={()=>remV(v.id)} style={{ background:"#FDE8E8", border:"none", borderRadius:7, padding:"6px 8px", color:"#C84B4B", cursor:"pointer" }}><X size={12}/></button>}
            </div>
          ))}
          <button onClick={addV} style={{ background:"none", border:"1px dashed #C4B4A0", borderRadius:8, padding:"7px", fontSize:13, color:"#8C7C6C", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}><Plus size={12}/> เพิ่มรูปแบบ</button>
        </div>
      </Field>
      <ModGroupEditor mgs={mgs} setMgs={setMgs}/>
      <ModalFooter onCancel={onClose} onSave={save}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CASH MANAGEMENT MODALS
// ─────────────────────────────────────────────────────────────
function CashInitModal({ onSave, onClose }) {
  const [cap, setCap]   = useState("");
  const [prof, setProf] = useState("");
  return (
    <div>
      <ModalTitle>💰 ตั้งค่าเงินเริ่มต้น</ModalTitle>
      <div style={{ fontSize:13, color:"#8C7C6C", marginBottom:14, lineHeight:1.6 }}>กรอกยอดเงินทุนและกำไรที่มีอยู่ในปัจจุบัน ระบบจะสร้างรายการบันทึกไว้ใน Ledger</div>
      <Field label="ยอดเงินทุน (฿)"><input type="number" value={cap} onChange={e=>setCap(e.target.value)} placeholder="0" style={iStyle}/></Field>
      <Field label="ยอดกำไรสะสม (฿)"><input type="number" value={prof} onChange={e=>setProf(e.target.value)} placeholder="0" style={iStyle}/></Field>
      <ModalFooter onCancel={onClose} onSave={() => { onSave(parseFloat(cap)||0, parseFloat(prof)||0); }}/>
    </div>
  );
}
function ExpenseModal({ onSave, onClose }) {
  const [amt, setAmt]   = useState("");
  const [desc, setDesc] = useState("");
  return (
    <div>
      <ModalTitle>💸 จ่ายทุน</ModalTitle>
      <Field label="จำนวนเงิน (฿)"><input type="number" value={amt} onChange={e=>setAmt(e.target.value)} placeholder="0" style={iStyle}/></Field>
      <Field label="รายละเอียด"><input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="เช่น ซื้อวัตถุดิบ" style={iStyle}/></Field>
      <ModalFooter onCancel={onClose} onSave={() => { if(!amt||parseFloat(amt)<=0)return; onSave(parseFloat(amt), desc); }}/>
    </div>
  );
}
function WithdrawalModal({ onSave, onClose }) {
  const [amt, setAmt] = useState("");
  return (
    <div>
      <ModalTitle>💰 ถอนกำไร</ModalTitle>
      <Field label="จำนวนเงินที่ถอน (฿)"><input type="number" value={amt} onChange={e=>setAmt(e.target.value)} placeholder="0" style={iStyle}/></Field>
      <ModalFooter onCancel={onClose} onSave={() => { if(!amt||parseFloat(amt)<=0)return; onSave(parseFloat(amt)); }}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SHARED MICRO COMPONENTS
// ─────────────────────────────────────────────────────────────
function CartItem({ item, onQty, onDone, onEdit }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:7, padding:"7px 4px", borderBottom:"1px solid #EDE4DA", opacity:item.done?.5:1 }}>
      <input type="checkbox" checked={item.done} onChange={() => onDone(item.key)} style={{ accentColor:"#6B4F3A", width:15, height:15, cursor:"pointer", flexShrink:0 }}/>
      <div onClick={onEdit ? () => onEdit(item) : undefined} style={{ flex:1, minWidth:0, cursor:onEdit?"pointer":"default" }}>
        <div style={{ fontSize:12, fontWeight:600, color:"#2C1810", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", textDecoration:item.done?"line-through":"none" }}>
          {item.name} ({item.variant}){onEdit&&<span style={{ fontSize:9, color:"#C8A882", marginLeft:4 }}>✎</span>}
        </div>
        {item.note && <div style={{ fontSize:10, color:"#7941C8", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>— {item.note}</div>}
        <div style={{ fontSize:11, color:"#8C7C6C" }}>฿{item.price} / {item.unit||"รายการ"}</div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:3, flexShrink:0 }}>
        <button onClick={() => onQty(item.key,-1)} className="qty-btn">−</button>
        <span style={{ fontSize:13, fontWeight:600, minWidth:18, textAlign:"center", color:"#2C1810" }}>{item.qty}</span>
        <button onClick={() => onQty(item.key, 1)} className="qty-btn">+</button>
      </div>
      <span style={{ fontSize:12, fontWeight:700, color:"#6B4F3A", minWidth:46, textAlign:"right" }}>{baht(item.price*item.qty)}</span>
    </div>
  );
}
function AlertModal({ msg, onClose }) {
  return <div style={{ textAlign:"center", padding:"8px 0" }}><AlertTriangle size={38} color="#C87941" style={{ margin:"0 auto 12px" }}/><div style={{ fontSize:15, color:"#5C4A36", marginBottom:20, lineHeight:1.6, whiteSpace:"pre-line" }}>{msg}</div><button onClick={onClose} style={{ background:"#2C1810", color:"#FFF", border:"none", borderRadius:10, padding:"10px 28px", cursor:"pointer", fontSize:14, fontFamily:"inherit" }}>ตกลง</button></div>;
}
function ConfirmModal({ icon, msg, confirmLabel, confirmColor, onConfirm, onCancel }) {
  return <div style={{ textAlign:"center", padding:"8px 0" }}>{icon}<div style={{ fontSize:15, color:"#5C4A36", marginBottom:22, lineHeight:1.7, whiteSpace:"pre-line" }}>{msg}</div><div style={{ display:"flex", gap:10 }}><button onClick={onCancel} style={{ flex:1, background:"#F0E8DC", color:"#5C4A36", border:"none", borderRadius:10, padding:"11px", fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>ยกเลิก</button><button onClick={onConfirm} style={{ flex:1, background:confirmColor||"#C84B4B", color:"#FFF", border:"none", borderRadius:10, padding:"11px", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>{confirmLabel||"ยืนยัน"}</button></div></div>;
}
function Overlay({ children, onClose, wide }) {
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(28,12,4,.58)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, backdropFilter:"blur(5px)" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"#FFFCF8", borderRadius:20, padding:26, width:wide?560:390, maxHeight:"92vh", overflowY:"auto", boxShadow:"0 28px 72px rgba(0,0,0,.3)", border:"1px solid #E8D8C8" }}>
        {children}
      </div>
    </div>
  );
}
function SecLabel({ children }) { return <div style={{ fontSize:12, color:"#8C7C6C", fontWeight:600, marginBottom:7 }}>{children}</div>; }
function IconBtn({ variant, onClick, children }) { return <button onClick={onClick} className={`icon-btn ${variant}`}>{children}</button>; }
function ChipBtn({ active, onClick, color, children }) { return <button onClick={onClick} style={{ background:active?color:"#F0E8DC", color:active?"#FFF":"#5C4A36", border:"none", borderRadius:20, padding:"4px 14px", fontSize:13, cursor:"pointer", fontFamily:"inherit", transition:"all .15s" }}>{children}</button>; }
function ColorPicker({ value, onChange }) { return <div style={{ display:"flex", flexWrap:"wrap", gap:7, marginTop:2 }}>{PALETTE.map(c=><div key={c} onClick={()=>onChange(c)} style={{ width:28, height:28, borderRadius:7, background:c, cursor:"pointer", border:value===c?"3px solid #2C1810":"2px solid transparent", boxShadow:value===c?"0 0 0 2px #FFF,0 0 0 4px #2C1810":"none", transition:"all .15s" }}/>)}</div>; }
function ModalTitle({ children }) { return <div style={{ fontWeight:700, fontSize:16, color:"#2C1810", marginBottom:18 }}>{children}</div>; }
function Field({ label, children }) { return <div style={{ marginBottom:14 }}><div style={{ fontSize:12, color:"#8C7C6C", marginBottom:5, fontWeight:500 }}>{label}</div>{children}</div>; }
function ModalFooter({ onCancel, onSave }) { return <div style={{ display:"flex", gap:10, marginTop:4 }}><button onClick={onCancel} style={{ flex:1, background:"#F0E8DC", color:"#5C4A36", border:"none", borderRadius:10, padding:"11px", fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>ยกเลิก</button><button onClick={onSave} style={{ flex:2, background:"#2C1810", color:"#FFF", border:"none", borderRadius:10, padding:"11px", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>บันทึก</button></div>; }
function EmptyMsg({ label }) { return <div style={{ textAlign:"center", color:"#9C8C7C", padding:"40px 0", fontSize:14 }}><Coffee size={32} style={{ margin:"0 auto 10px", opacity:.35 }}/><br/>{label}</div>; }

const iStyle = { width:"100%", padding:"9px 12px", borderRadius:9, border:"1px solid #D4C4B0", fontSize:14, background:"#F5F0EA", color:"#2C1810", outline:"none", fontFamily:"inherit" };
