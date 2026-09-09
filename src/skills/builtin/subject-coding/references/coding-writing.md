# 编程讲义写作示例

## 概念三要素

差：useMemo 是一个很有用的 Hook，能提升性能。
好：useMemo 缓存计算结果，依赖不变时跳过重算。用于计算开销大、且渲染间结果可复用的场景。

## API 表述

差：这个函数接受一些参数，返回处理后的结果。
好：splitIntoCues(segments, maxLen) 接收字幕段数组与单条最大字数，返回展示用 cue 数组；超长句按标点再细分。

## 对比表（table 块）

{"type":"table","caption":"两个 Hook 的特性对比","header":["特性","useEffect","useLayoutEffect"],"rows":[["执行时机","绘制后异步","绘制前同步"],["阻塞渲染","否","是"],["典型场景","数据获取、订阅","读取布局并改 DOM"]]}

## 代码处理

- 关键代码画面：{"type":"figure","time":"12:30","caption":"useEffect 依赖数组写法"}
- 句内短调用：依赖数组为空时 useEffect(fn, []) 只在挂载后执行一次。
- 命令原样转写：构建产物前先执行 npm run build。
