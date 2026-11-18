// Vite uses "./" for packaged Electron (file://) and "/" for web builds.
const directory = `${import.meta.env.BASE_URL}meeting-backgrounds/`;

function scene<const Id extends `scene-${string}`>(id: Id, label: string) {
  return { id, label, url: `${directory}${id}.jpg` } as const;
}

export const MEETING_BACKGROUND_PRESETS = [
  scene("scene-cafe", "街角咖啡馆"),
  scene("scene-meeting-room", "投影会议室"),
  scene("scene-office", "办公室休息区"),
  scene("scene-apartment", "格拉纳达公寓客厅"),
  scene("scene-bookshelves", "图书馆书架"),
  scene("scene-classroom", "绿植教室"),
  scene("scene-glass-walkway", "机场玻璃连廊"),
  scene("scene-hotel-suite", "酒店套房会客区"),
  scene("scene-winter-garden", "冬季花园中庭"),
  scene("scene-forest-path", "林间小径"),
  scene("scene-alpine-lake", "高山湖泊"),
] as const;
