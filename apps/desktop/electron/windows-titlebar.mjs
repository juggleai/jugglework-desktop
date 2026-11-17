export const WINDOWS_TITLE_BAR_HEIGHT = 44;
export const WINDOWS_TITLE_BAR_CONTROLS_WIDTH = 138;

export function windowsTitleBarOverlay(dark) {
  return {
    color: dark ? "#18191b" : "#f7f7f7",
    symbolColor: dark ? "#f5f5f5" : "#202124",
    height: WINDOWS_TITLE_BAR_HEIGHT,
  };
}

export function windowsTitleBarOptions(dark) {
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: windowsTitleBarOverlay(dark),
  };
}
