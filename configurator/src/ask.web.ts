// A question with buttons, desktop: runs the choice at once. The desktop window (WKWebView through wry) shows no
// confirm dialog and answers "cancel" to every confirm(), so asking would block the choice for good. The app's only
// question is entering or leaving the demo, which a click on the logo toggles back.
type Button = { text?: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void };

export function ask(_title: string, _message: string, buttons: Button[]) {
  buttons.find(button => button.style !== 'cancel')?.onPress?.();
}
