!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Smazat i všechna data aplikace (databázi, podpisy, nastavení)?" IDNO ponechatData
      RMDir /r "$APPDATA\guestbook"
      RMDir /r "$APPDATA\lintech-kiosek"
      RMDir /r "$LOCALAPPDATA\guestbook"
      RMDir /r "$LOCALAPPDATA\guestbook-updater"
      RMDir /r "$LOCALAPPDATA\lintech-kiosek"
    ponechatData:
  ${endIf}
!macroend
