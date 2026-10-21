// A question with buttons, desktop: a confirm dialog. The button that is not "cancel" is the choice; the cancel one
// runs otherwise. Only questions with one choice and a cancel exist in the app.
type Button = { text?: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void };

export function ask(title: string, message: string, buttons: Button[]) {
  const choice = buttons.find(button => button.style !== 'cancel');
  const cancel = buttons.find(button => button.style === 'cancel');
  const confirmed = (globalThis as { confirm?: (text: string) => boolean }).confirm?.(`${title}\n\n${message}`) ?? false;
  (confirmed ? choice : cancel)?.onPress?.();
}
