import greetingPeriods from '../config/chatGreetings.json';

/** 按用户本地时间选择问候语；只在进入页面时调用，避免标题随重渲染跳动。 */
export function chatGreeting(date = new Date(), random = Math.random()): string {
  const hour = date.getHours();
  const period = greetingPeriods.find((_, index) =>
    index === greetingPeriods.length - 1 || hour < greetingPeriods[index + 1].start,
  )!;
  return period.messages[Math.floor(random * period.messages.length)];
}
