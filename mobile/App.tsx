import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

export default function App() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.badge}>Diligence OS</Text>
        <Text style={styles.title}>Mobile workspace scaffolded</Text>
        <Text style={styles.subtitle}>Expo + React Native baseline is ready for future feature slices.</Text>
        <StatusBar style="light" />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#020617"
  },
  container: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 16
  },
  badge: {
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 2,
    fontSize: 12
  },
  title: {
    color: "#f8fafc",
    fontSize: 34,
    fontWeight: "700"
  },
  subtitle: {
    color: "#cbd5e1",
    fontSize: 16,
    lineHeight: 24
  }
});
