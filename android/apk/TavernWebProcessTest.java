package com.deepseekharness.app.util;

import org.junit.Test;
import static org.junit.Assert.*;

public class TavernWebProcessTest {
    @Test public void tavernUsesNativeWebLifecycleWithoutBroadeningKillScope() {
        String command = "node /usr/local/bin/dsh --profile tavern --no-open --host 127.0.0.1 --port 3080";
        assertTrue(WebProcSel.maySignalWeb(command));
        assertTrue(WebProcSel.looksLikeWeb(command));
        assertFalse(WebProcSel.maySignalWeb("bash -c " + command));
        assertFalse(WebProcSel.maySignalWeb("libproot.so " + command));
        assertFalse(WebProcSel.maySignalWeb(command.replace("--profile tavern", "--profile personal")));
        assertFalse(WebProcSel.maySignalWeb(command.replace("--profile tavern", "--profile tavern-other")));
    }
}
