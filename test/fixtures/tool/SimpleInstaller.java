package net.minecraftforge.installer;

// Имитация свежего официального установщика Forge (fatjar): та же точка входа SimpleInstaller,
// профиль install_profile.json берёт из установщика конкретной версии, лежащего в classpath.
public class SimpleInstaller {
  public static void main(String[] a) throws Exception {
    FakeForgeInstaller.run(a, true);
  }
}
