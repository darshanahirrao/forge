/** Reuse the existing Codex protocol fixture through the same public driver contract. */
export function harnessExtensionCode({
  sdk,
  rpc,
  agent,
  release = '1.0.0',
  id = 'ext.owned.executor',
  accountReader,
}) {
  return `import { CodexDriver } from ${JSON.stringify(sdk)};
import { NativeRpc } from ${JSON.stringify(rpc)};
export default {format:'forge.extension',version:1,id:'owned.executor',name:'Owned execution extension',release:${JSON.stringify(release)},harnesses:[{
 id:${JSON.stringify(id)},name:'Owned native harness',contract:1,nativeVersion:'owned-app-server',profileFiles:['config.toml'],
 ${accountReader ? 'accountReader:' + JSON.stringify(accountReader) + ',' : ''}
 create:()=>new CodexDriver(options=>new NativeRpc({...options,binary:process.execPath,args:[${JSON.stringify(agent)}],env:{...options.env,FORGE_FIXTURE_PROJECT:options.cwd,FORGE_FIXTURE_EXECUTOR_CAPTURE:options.env.CODEX_HOME+'/scope.json'}}),async()=>process.execPath)
}]};`;
}
