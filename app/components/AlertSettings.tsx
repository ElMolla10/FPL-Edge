"use client";
import {useEffect,useId,useState} from "react";

/**
 * Account setting: "Email me if the weekly call changes." (default OFF). Signed-in only; persisted server-side
 * (D1 via /api/account/notifications, session cookie), never browser-storage-only. Disabled on the labelled demo
 * squad: demo state never writes notification state onto the real account (and the server never mails demo).
 */
type Prefs={notifyCallChanges:boolean;hasConnectedTeam:boolean;email:string};
export function AlertSettings({demo,variant="card"}:{demo:boolean;variant?:"card"|"sheet"}){
  const id=useId();
  const[prefs,setPrefs]=useState<Prefs|null>(null);
  const[state,setState]=useState<"loading"|"ready"|"signed-out"|"error">("loading");
  const[busy,setBusy]=useState(false);
  const[msg,setMsg]=useState("");
  useEffect(()=>{
    let alive=true;
    fetch("/api/account/notifications",{cache:"no-store"}).then(async r=>{
      if(r.status===401){if(alive)setState("signed-out");return}
      const j=await r.json();
      if(!alive)return;
      if(!r.ok){setState("error");setMsg(j.error||"Could not load alert settings.");return}
      setPrefs(j);setState("ready");
    }).catch(()=>{if(alive){setState("error");setMsg("Could not load alert settings.")}});
    return()=>{alive=false};
  },[]);
  const toggle=async(next:boolean)=>{
    if(demo||busy||!prefs)return;
    setBusy(true);setMsg("");
    const before=prefs;
    setPrefs({...prefs,notifyCallChanges:next});
    try{
      const r=await fetch("/api/account/notifications",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({notifyCallChanges:next})});
      const j=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(j.error||"Could not save.");
      setPrefs(j);setMsg(next?"Saved. We'll email you when the call changes.":"Saved. Alerts are off.");
    }catch(e){setPrefs(before);setMsg(e instanceof Error?e.message:"Could not save.")}
    finally{setBusy(false)}
  };
  if(state==="signed-out"||state==="loading")return null;
  return <section className={variant==="sheet"?"alert-settings alert-settings-sheet":"alert-settings"} aria-label="Email alerts">
    <label className="alert-settings-row" htmlFor={id}>
      <input id={id} type="checkbox" checked={prefs?.notifyCallChanges===true} disabled={demo||busy||!prefs} onChange={e=>toggle(e.target.checked)}/>
      <span>Email me if the weekly call changes.</span>
    </label>
    {prefs&&<small className="alert-settings-note">{demo?"Alerts are off on the demo squad. Connect your real FPL team to use them.":`Alerts go to ${prefs.email}.${prefs.hasConnectedTeam?"":" Connect your FPL team to receive them."}`}</small>}
    {msg&&<small className="alert-settings-msg" role="status">{msg}</small>}
  </section>;
}
