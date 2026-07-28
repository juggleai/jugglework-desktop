import { PasswordResetEmail, type PasswordResetEmailProps } from "../src/templates/password-reset"

export default function PasswordResetPreview(props: PasswordResetEmailProps) {
  return <PasswordResetEmail {...props} />
}

PasswordResetPreview.PreviewProps = {
  resetLink: "https://work.juggle.im/api/auth/reset-password/example-token?callbackURL=https%3A%2F%2Fwork.juggle.im%2Freset-password",
} satisfies PasswordResetEmailProps
