export function createMeetingAnnotationRouter({ legacy, semantic }) {
  const selected = event => semantic.state(event).selected === true;
  return {
    state(event) {
      const state = semantic.state(event);
      return state.selected ? state : legacy.state(event);
    },
    open(event) {
      return selected(event) ? semantic.open(event) : legacy.open(event);
    },
    async close(event, input) {
      await semantic.close(event, input);
      await legacy.close(event, input);
    },
    windowShareReady(event, input) {
      semantic.windowShareReady(event, input);
      if (!selected(event)) legacy.windowShareReady(event, input);
    },
    writeSemantic: (event, input) => semantic.write(event, input),
  };
}
