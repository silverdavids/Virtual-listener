const {performance}=require('node:perf_hooks');
const bounded=(value,fallback,min,max)=>Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max?Number(value):fallback;
let refreshGeneration=0;
const requestRefresh=()=>{refreshGeneration++;};
const generation=()=>refreshGeneration;
function createObservationClock({wall=Date.now,monotonic=()=>performance.now(),thresholdMs=process.env.VH_CLOCK_DISCONTINUITY_MS,log=console.log,onDiscontinuity=requestRefresh}={}) {
 const threshold=bounded(thresholdMs,5000,1000,60000);
 let previousWall=wall(),previousMono=monotonic(),utc=previousWall;
 return {thresholdMs:threshold,sample(){
  const nextWall=wall(),mono=monotonic(),elapsed=Math.max(0,mono-previousMono);
  const adjustment=nextWall-previousWall-elapsed;
  const discontinuity=!Number.isFinite(adjustment)||Math.abs(adjustment)>threshold;
  utc+=discontinuity?elapsed:Math.max(0,nextWall-previousWall);
  previousWall=nextWall;previousMono=mono;
  if(discontinuity){log(`CLOCK-DISCONTINUITY direction=${adjustment<0?'backward':'forward'} deltaMs=${Number.isFinite(adjustment)?Math.round(adjustment):'invalid'} thresholdMs=${threshold}`);onDiscontinuity();}
  return {utc,mono,discontinuity,adjustmentMs:adjustment};
 }};
}
module.exports={createObservationClock,bounded,generation};
