export const motionTokens={duration:{fast:.18,normal:.35,slow:.6},easing:{smooth:[.22,1,.36,1] as const}};
export const springs={snappy:{type:'spring' as const,stiffness:300,damping:30},gentle:{type:'spring' as const,stiffness:170,damping:25},bouncy:{type:'spring' as const,stiffness:400,damping:20},instant:{type:'spring' as const,stiffness:600,damping:35},release:{type:'spring' as const,stiffness:200,damping:25}};
export const shouldAnimate=(reduced:boolean|null)=>!reduced;
