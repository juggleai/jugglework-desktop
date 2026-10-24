/** 按非透明人物高度与本机Codex默认约100DIP对齐；图集原始cell保持384×416，避免有损重采样。 */
export const PET_WIDTH = 104;
export const PET_HEIGHT = PET_WIDTH * 208 / 192;
export const PET_HIT_SCALE = PET_WIDTH / 192;
/** 给胶囊和任务卡的柔和阴影预留原生透明边距，正文宽度仍为336 DIP。 */
export const PET_WINDOW_WIDTH = 400;
