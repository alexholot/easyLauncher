package net.minecraftforge.installer;

import java.io.*;
import java.nio.file.*;

// Имитация установщика Forge/NeoForge 2.x (не Forge): те же ключи --installClient/--install-client
// и --installServer/--install-server, те же требования (launcher_profiles.json для клиента)
// и те же результаты — профиль версии клиента и файл аргументов сервера.
public class FakeForgeInstaller {
  public static void main(String[] a) throws Exception {
    run(a, false);
  }
  // viaTool — запуск через «свежий установщик»; без него установщик с "nocli" ведёт себя как старый 2.0
  public static void run(String[] a, boolean viaTool) throws Exception {
    String profile = new String(FakeForgeInstaller.class.getResourceAsStream("/install_profile.json").readAllBytes(), "UTF-8");
    if (!viaTool && profile.contains("\"nocli\"") && a.length > 0 && a[0].equals("--installClient")) {
      System.out.println("Exception in thread \"main\" joptsimple.UnrecognizedOptionException: installClient is not a recognized option");
      System.exit(1);
    }
    String version = field(profile, "version");
    String mc = field(profile, "minecraft");
    String loader = field(profile, "loader");
    String lv = field(profile, "loaderVersion");
    for (int i = 0; i < a.length - 1; i++) {
      String opt = a[i];
      Path dir = Paths.get(a[i + 1]);
      if (opt.equals("--installClient") || opt.equals("--install-client")) {
        if (!Files.exists(dir.resolve("launcher_profiles.json"))) { System.out.println("There is no minecraft launcher profile, you need to run the launcher first!"); System.exit(1); }
        Path json = dir.resolve("versions").resolve(version).resolve(version + ".json");
        Files.createDirectories(json.getParent());
        Files.write(json, ("{\"id\":\"" + version + "\",\"inheritsFrom\":\"" + mc + "\",\"mainClass\":\"FakeClient\",\"arguments\":{\"game\":[\"--launchTarget\",\"" + loader + "client\"],\"jvm\":[\"-Dfake.loader=" + loader + "\"]},\"libraries\":[]}").getBytes("UTF-8"));
        System.out.println("Successfully installed client profile " + version);
        return;
      }
      if (opt.equals("--installServer") || opt.equals("--install-server")) {
        String base = loader.equals("forge") ? "libraries/net/minecraftforge/forge/" + mc + "-" + lv : "libraries/net/neoforged/neoforge/" + lv;
        Path argsDir = dir.resolve(base);
        Files.createDirectories(argsDir);
        String args = "-cp " + System.getenv("FAKE_SERVER_JAR") + " FakeServer\n";
        Files.write(argsDir.resolve("unix_args.txt"), args.getBytes("UTF-8"));
        Files.write(argsDir.resolve("win_args.txt"), args.getBytes("UTF-8"));
        System.out.println("The server installed successfully");
        return;
      }
    }
    System.out.println("Exception in thread \"main\" joptsimple.UnrecognizedOptionException");
    System.exit(1);
  }
  static String field(String json, String name) {
    int i = json.indexOf("\"" + name + "\"");
    int s = json.indexOf('"', json.indexOf(':', i) + 1);
    return json.substring(s + 1, json.indexOf('"', s + 1));
  }
}
