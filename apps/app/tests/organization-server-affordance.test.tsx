/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { t } from "../src/i18n";
import { defaultControlPlaneUrl } from "../src/react-app/domains/settings/cloud/control-plane-url";

mock.module("../src/components/ui/dialog", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => open ? <>{children}</> : null,
    DialogContent: Box,
    DialogDescription: Box,
    DialogFooter: Box,
    DialogHeader: Box,
    DialogTitle: Box,
  };
});

const { OrganizationServerAffordance } = await import(
  "../src/react-app/domains/settings/cloud/organization-server-affordance"
);

test.each(["", "  \t  "])("saving cleared server input %j restores the app default", async (blank) => {
  const originalActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const onSave = mock(async (_url: string) => true);
  let view: ReactTestRenderer | undefined;
  try {
    const customUrl = "https://private.example.com";
    await act(async () => {
      view = create(<OrganizationServerAffordance busy={false} error={null} onSave={onSave} url={customUrl} />);
    });
    const root = view!.root;
    const button = (label: string) => root.findAllByType("button").find((node) => node.children.includes(label))!;
    await act(async () => { button(t("welcome.organization_server_change")).props.onClick(); });
    const input = root.findByType("input");
    expect(input.props.value).toBe(customUrl);

    await act(async () => { input.props.onChange({ currentTarget: { value: "ftp://private.example.com" } }); });
    expect(button(t("common.save")).props.disabled).toBe(true);
    await act(async () => { input.props.onChange({ currentTarget: { value: blank } }); });
    expect(button(t("common.save")).props.disabled).toBe(false);
    await act(async () => { button(t("common.save")).props.onClick(); });

    expect(onSave).toHaveBeenCalledWith(defaultControlPlaneUrl());
    expect(root.findAllByType("input")).toHaveLength(0);
  } finally {
    await act(async () => { view?.unmount(); });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment);
  }
});
