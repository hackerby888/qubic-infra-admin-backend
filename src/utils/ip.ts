export interface IpInfo {
    country: string;
    region: string;
    city: string;
    isp: string;
}

export async function lookupIp(ip: string): Promise<IpInfo> {
    let url = `http://ip-api.com/json/${ip}`;
    try {
        let response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch IP info: ${response.statusText}`);
        }
        let data = await response.json();
        return {
            country: data.country || "Unknown",
            region: data.regionName || "Unknown",
            city: data.city || "Unknown",
            isp: data.isp || "Unknown",
        };
    } catch (error) {
        return {
            country: "Unknown",
            region: "Unknown",
            city: "Unknown",
            isp: "Unknown",
        };
    }
}
