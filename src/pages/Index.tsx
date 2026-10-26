import { Hero } from "@/components/Hero";
import Layout from "@/components/Layout";
import AIAgentDiscovery from "@/components/AIAgentDiscovery";

const Index = () => (
  <Layout>
    <AIAgentDiscovery page="home" />
    <Hero />
  </Layout>
);

export default Index;
