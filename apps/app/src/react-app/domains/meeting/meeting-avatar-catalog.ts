export const meetingAvatars = {
  cat: ["猫咪", "🐱"], robot: ["机器人", "🤖"], pig: ["小猪", "🐷"], penguin: ["企鹅", "🐧"],
  dog: ["小狗", "🐶"], rabbit: ["白兔", "🐰"], panda: ["熊猫", "🐼"], fox: ["狐狸", "🦊"],
  bear: ["小熊", "🐻"], owl: ["猫头鹰", "🦉"], koala: ["考拉", "🐨"], tiger: ["小老虎", "🐯"],
  monkey: ["小猴", "🐵"], frog: ["青蛙", "🐸"], lion: ["狮子", "🦁"], sunglasses: ["墨镜", "😎"],
  glasses: ["眼镜", "🤓"], mask: ["口罩", "😷"], cowboy: ["牛仔", "🤠"], astronaut: ["宇航员", "🧑‍🚀"],
} as const;
export type MeetingAvatar = keyof typeof meetingAvatars;
export const isMeetingAvatar = (id: unknown): id is MeetingAvatar => typeof id === "string" && Object.hasOwn(meetingAvatars, id);
