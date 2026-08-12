import type { AutomationPromptTemplate, AutomationSchedule } from "@jugglework/types/automation";

export const AUTOMATION_TEMPLATE_CATALOG_VERSION = 1 as const;

export type AutomationTemplate = {
  version: typeof AUTOMATION_TEMPLATE_CATALOG_VERSION;
  id: string;
  icon: string;
  title: string;
  description: string;
  prompt: string;
  promptTemplate: AutomationPromptTemplate;
  localized: Record<"zh-CN" | "en-US", { title: string; description: string; prompt: string }>;
  schedule?: TemplateSchedule;
  recommendedConnectorIds: string[];
};

type TemplateSchedule = AutomationSchedule extends infer Schedule
  ? Schedule extends AutomationSchedule ? Omit<Schedule, "timezone"> : never
  : never;

/** 随 Desktop 版本发布、完全位于客户端的自动化模板目录。 */
export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  template("daily-ai-news", "newspaper", "每日 AI 新闻推送", "关注当天 AI 领域的重要动态，侧重可信来源与实际影响。", "检索并总结今天 AI 领域最重要的新闻。按重要性排序，标注来源、发布时间和实际影响，最后给出三条值得继续关注的线索。", daily("08:30"), ["web"]),
  template("daily-english-words", "languages", "每日 5 个英语单词", "每天推荐 5 个高频实用英语单词，包含例句与复习。", "推荐 5 个高频实用英语单词。为每个词给出音标、中文释义、自然例句和记忆提示，并复习上一期内容。", daily("08:00")),
  template("bedtime-story", "moon", "每日儿童睡前故事", "生成 3–5 分钟可读的温和睡前故事。", "创作一篇适合儿童睡前阅读的温和故事，阅读时长约 3–5 分钟。避免恐怖、暴力和说教，结尾温暖。", daily("20:30")),
  template("weekly-work-report", "clipboard", "每周工作周报", "每周五汇总仓库 PR 与 Issue 进展。", "检查当前工作空间本周的提交、PR、Issue 和待办，整理为简洁周报：本周完成、进行中、风险、下周计划。不要捏造缺失信息。", weekly([5], "17:30"), ["github"]),
  template("classic-movie", "clapperboard", "经典电影推荐", "推荐一部高分经典电影，简要介绍但不剧透。", "推荐一部值得观看的高分经典电影。说明推荐理由、时代背景、适合人群和观看提示，不要泄露关键剧情。", weekly([6], "18:00")),
  template("today-in-history", "calendar", "历史上的今天", "从科技、电影、音乐等领域挑选值得了解的事件。", "整理历史上的今天发生的 5 件重要事件，覆盖科技、文化、社会等领域；注明年份和可靠来源，并简述其后续影响。", daily("09:00"), ["web"]),
  template("daily-why", "lightbulb", "每日一个为什么", "每天抛出一个有趣问题，先提问再解释。", "提出一个贴近日常但值得深入思考的“为什么”问题。先只展示问题并留出思考提示，再给出清晰、可靠、适合非专业读者的解释。", daily("12:00")),
  template("call-parents", "contact", "父母联系提醒", "每周日 10:00 提醒你给家人打电话。", "提醒我给父母或家人打电话，并给出三个自然的聊天话题建议。内容简短、温暖。", weekly([7], "10:00")),
  template("physical-checkup", "mailbox", "体检预约提醒", "在指定时间提醒确认体检预约与准备事项。", "提醒我确认体检预约，并列出需要核实的时间、地点、空腹要求、证件和交通安排。", undefined),
  template("interview-prep", "message", "面试准备提醒", "工作日每 2 小时提醒你复习大模型面试知识。", "安排一次 20 分钟的大模型面试复习：给出一个核心知识点、两道追问和一道实践题，最后提供简短参考答案。", undefined),
  template("meeting-prep", "list", "会议前准备", "在会议开始前提醒整理议题、目标和材料。", "帮我整理下一场会议的准备清单：目标、议题、需要的数据、待确认问题和预期决策。无法读取日历时明确提醒我补充会议信息。", undefined, ["calendar"]),
  template("cute-pet-wallpaper", "image", "可爱萌宠手机壁纸", "随机从 7 种不同风格中挑选一种生成壁纸。", "随机选择一种视觉风格，生成一张可爱萌宠手机壁纸。画面适配竖屏，主体清晰，预留图标区域，不包含文字和水印。", weekly([7], "09:30")),
] as const;

function template(
  id: string,
  icon: string,
  title: string,
  description: string,
  prompt: string,
  schedule?: TemplateSchedule,
  recommendedConnectorIds: string[] = [],
): AutomationTemplate {
  const english = templateEnglish(id);
  if (!english) throw new Error(`Missing localized automation template: ${id}`);
  return {
    version: AUTOMATION_TEMPLATE_CATALOG_VERSION,
    id,
    icon,
    title,
    description,
    prompt,
    promptTemplate: { version: 1, parts: [{ type: "text", text: prompt }] },
    localized: {
      "zh-CN": { title, description, prompt },
      "en-US": english,
    },
    ...(schedule ? { schedule } : {}),
    recommendedConnectorIds,
  };
}

function templateEnglish(id: string): { title: string; description: string; prompt: string } | undefined {
  return ({
  "daily-ai-news": { title: "Daily AI news", description: "Follow important AI developments from credible sources.", prompt: "Find and summarize today's most important AI news. Rank it by importance, cite sources and publication times, explain practical impact, and end with three developments to watch." },
  "daily-english-words": { title: "Five English words a day", description: "Learn five useful high-frequency words with examples and review.", prompt: "Recommend five useful high-frequency English words. Include pronunciation, a Chinese definition, a natural example, a memory aid, and a review of the previous set." },
  "bedtime-story": { title: "Daily bedtime story", description: "Create a gentle three-to-five-minute children's story.", prompt: "Write a gentle children's bedtime story that takes three to five minutes to read. Avoid horror, violence, and preaching, and end warmly." },
  "weekly-work-report": { title: "Weekly work report", description: "Summarize repository PR and issue progress every Friday.", prompt: "Review this workspace's commits, pull requests, issues, and tasks for the week. Produce a concise report with completed work, work in progress, risks, and next-week plans. Do not invent missing information." },
  "classic-movie": { title: "Classic movie recommendation", description: "Recommend a highly rated classic without spoilers.", prompt: "Recommend one highly rated classic film. Explain why it is worth watching, its historical context, suitable audiences, and viewing notes without revealing key plot points." },
  "today-in-history": { title: "Today in history", description: "Select notable events from technology, film, music, and more.", prompt: "Present five important events that happened on this date across technology, culture, and society. Include the year, credible sources, and a brief note on later impact." },
  "daily-why": { title: "A daily why", description: "Ask one interesting question, then explain it clearly.", prompt: "Pose an everyday but thought-provoking why question. Show the question and a thinking hint first, then give a clear, reliable explanation for a general audience." },
  "call-parents": { title: "Call family reminder", description: "Remind you every Sunday at 10:00 to call family.", prompt: "Remind me to call my parents or family and suggest three natural conversation topics. Keep it brief and warm." },
  "physical-checkup": { title: "Health check appointment", description: "Remind you to confirm an appointment and preparation details.", prompt: "Remind me to confirm my health check appointment and list the time, location, fasting rules, documents, and transport details I should verify." },
  "interview-prep": { title: "Interview preparation", description: "Review large-model interview knowledge every two workday hours.", prompt: "Plan a twenty-minute large-model interview review with one core concept, two follow-up questions, one practical task, and short reference answers." },
  "meeting-prep": { title: "Meeting preparation", description: "Prepare topics, goals, and materials before a meeting.", prompt: "Prepare a checklist for my next meeting: objective, agenda, required data, open questions, and expected decisions. Ask me for meeting details when calendar access is unavailable." },
  "cute-pet-wallpaper": { title: "Cute pet wallpaper", description: "Choose one of seven styles and generate a mobile wallpaper.", prompt: "Randomly select a visual style and create a cute pet phone wallpaper. Use a portrait layout, keep the subject clear, reserve space for icons, and include no text or watermark." },
  } satisfies Record<string, { title: string; description: string; prompt: string }>)[id];
}

function daily(localTime: string): TemplateSchedule {
  return { version: 1, kind: "calendar", frequency: "daily", localTime };
}

function weekly(weekdays: number[], localTime: string): TemplateSchedule {
  return { version: 1, kind: "calendar", frequency: "weekly", weekdays, localTime };
}
