import { createRouter, createWebHashHistory } from "vue-router";
import { useHelloStore } from "@/stores/hello";
import { juggleworkManaged } from "@/stores/settings";
import { initialRoute } from "./initialRoute";

function firstRoute() {
  return initialRoute(juggleworkManaged.value, useHelloStore().load());
}

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: firstRoute,
    },
    {
      path: "/hello",
      beforeEnter: () => firstRoute() === "/home" ? { path: "/home", replace: true } : true,
      component: () => import("@/pages/hello/index.vue"),
    },
    {
      path: "/home",
      component: () => import("@/pages/home/index.vue"),
    },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      path: "/workspace",
      component: () => import("@/pages/workspace/index.vue"),
    },
  ],
});
export default router;
