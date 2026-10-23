import { nextTick, onMounted, onUnmounted, ref, watch, type ShallowRef } from 'vue';
import type { WorkspaceAction, WorkspaceState } from './workspace-contract';

/** Fullscreen is browser-owned; mode changes from tools may require a fresh click. */
export function usePresentation(canvas: ShallowRef<HTMLDivElement | null>, workspace: ShallowRef<WorkspaceState>, action: (input:WorkspaceAction)=>Promise<unknown>) {
  const requesting=ref(false),needsGesture=ref(false);
  let owned=false,disposed=false;
  const isFullscreen=()=>!!canvas.value && (canvas.value.getRootNode() as ShadowRoot).fullscreenElement===canvas.value;
  async function exit(){if(isFullscreen())await document.exitFullscreen().catch(()=>{});}
  async function enter(fromTool=false){
    if(requesting.value || disposed)return;
    const revision=workspace.value.workspaceRevision;
    requesting.value=true;needsGesture.value=false;
    try {
      await nextTick();
      if(!canvas.value)throw new Error('Canvas unavailable');
      if(!isFullscreen())await canvas.value.requestFullscreen();
      if(disposed || !isFullscreen())return;
      if(workspace.value.mode!=='presentation' && (fromTool || workspace.value.workspaceRevision!==revision)){await exit();return;}
      if(workspace.value.mode!=='presentation') {
        const result=await action({tool:'switch_mode',mode:'presentation'});
        if(!result)await exit();
      }
    } catch { if(!disposed && (workspace.value.workspaceRevision===revision || workspace.value.mode==='presentation'))needsGesture.value=true; }
    finally {requesting.value=false;}
  }
  function changed(){
    const active=isFullscreen();
    if(owned && !active && workspace.value.mode==='presentation')void action({tool:'switch_mode',mode:'preview'});
    owned=active;if(active)needsGesture.value=false;
  }
  watch(()=>workspace.value.mode,async(mode)=>{
    if(mode==='presentation') { if(!isFullscreen())await enter(true); }
    else {needsGesture.value=false;await exit();}
  },{flush:'post'});
  onMounted(()=>document.addEventListener('fullscreenchange',changed));
  onUnmounted(()=>{disposed=true;document.removeEventListener('fullscreenchange',changed);});
  return {requesting,needsGesture,enter:()=>enter()};
}
