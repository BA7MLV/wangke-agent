import CloudModels from '../Models';

/** 引导与设置共用模型目录、供应商发现及模型库，避免两套配置流程漂移。 */
export default function ModelSetup({ onDone }: { onDone: () => void }) {
  return <CloudModels standalone onDone={onDone} />;
}
