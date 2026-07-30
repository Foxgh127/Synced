!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P UDP"'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P TCP"'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P UDP v2"'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P TCP v2"'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="Synced P2P UDP v2" dir=in action=allow program="$INSTDIR\同频.exe" enable=yes profile=private,public protocol=UDP edge=no'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="Synced P2P TCP v2" dir=in action=allow program="$INSTDIR\同频.exe" enable=yes profile=private,public protocol=TCP edge=no'
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P UDP"'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P TCP"'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P UDP v2"'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P TCP v2"'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P UDP v2"'
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Synced P2P TCP v2"'
!macroend
