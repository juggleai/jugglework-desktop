export function initialRoute(managed: boolean, helloCompleted: boolean) {
  return managed || helloCompleted ? "/home" : "/hello";
}
