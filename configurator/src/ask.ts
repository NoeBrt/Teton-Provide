// A question with buttons. iOS: the system alert. The desktop build uses ask.web.ts (React Native's Alert does
// nothing on the web).
import { Alert, type AlertButton } from 'react-native';

export const ask = (title: string, message: string, buttons: AlertButton[]) => Alert.alert(title, message, buttons);
