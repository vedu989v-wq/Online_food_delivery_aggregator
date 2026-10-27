import kagglehub

# Download latest version
path = kagglehub.dataset_download("rrkcoder/zomato-data-40k-restaurants-of-indias-100-cities")

print("Path to dataset files:", path)