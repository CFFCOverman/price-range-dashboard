import fs from 'node:fs';
// The old file remains intact if preparing the replacement fails.
export function atomicText(file,text){
  const temp=file+'.pending-'+process.pid;
  fs.writeFileSync(temp,text,'utf8');
  fs.renameSync(temp,file);
}
